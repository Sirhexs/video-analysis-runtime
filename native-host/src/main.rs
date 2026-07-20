#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(not(windows))]
compile_error!("Video Analysis Runtime Host currently supports Windows only");

use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use std::os::windows::process::CommandExt;

const HOST_NAME: &str = "com.videoanalysis.runtime";
const SERVER_ADDR: &str = "127.0.0.1:18765";
const SERVER_URL: &str = "http://127.0.0.1:18765";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;
const START_TIMEOUT: Duration = Duration::from_secs(10);

#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptGenRandom(
        algorithm: *mut core::ffi::c_void,
        buffer: *mut u8,
        buffer_len: u32,
        flags: u32,
    ) -> i32;
}

const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;

#[derive(Debug)]
struct Health {
    version: String,
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if let Some(index) = args.iter().position(|value| value == "--action") {
        let action = args.get(index + 1).map(String::as_str).unwrap_or("status");
        let response = handle_action("cli", action);
        println!("{response}");
        if response.contains("\"ok\":false") {
            std::process::exit(1);
        }
        return;
    }

    match read_native_message() {
        Ok(Some(message)) => {
            let id = json_string_field(&message, "id").unwrap_or_else(|| "request".into());
            let action = json_string_field(&message, "action").unwrap_or_else(|| "status".into());
            let response = handle_action(&id, &action);
            let _ = write_native_message(&response);
        }
        Ok(None) => {}
        Err(error) => {
            let response = error_response("request", "invalid_message", &error.to_string());
            let _ = write_native_message(&response);
        }
    }
}

fn handle_action(id: &str, action: &str) -> String {
    let token = match load_or_create_token() {
        Ok(value) => value,
        Err(error) => return error_response(id, "config_error", &error),
    };

    match action {
        "status" => match check_health(&token) {
            Ok(health) => success_response(id, "running", &token, &health.version),
            Err(error) => offline_response(id, &token, &error),
        },
        "ensure_started" => match ensure_started(&token) {
            Ok(health) => success_response(id, "running", &token, &health.version),
            Err(error) => error_response(id, "start_failed", &error),
        },
        "restart" => {
            if check_health(&token).is_ok() {
                if let Err(error) = request_shutdown(&token) {
                    return error_response(id, "restart_blocked", &error);
                }
                if !wait_until_offline(Duration::from_secs(10)) {
                    return error_response(id, "restart_blocked", "服务退出超时");
                }
            }
            match ensure_started(&token) {
                Ok(health) => success_response(id, "running", &token, &health.version),
                Err(error) => error_response(id, "start_failed", &error),
            }
        }
        "stop" => {
            if check_health(&token).is_err() {
                stopped_response(id, &token)
            } else {
                match request_shutdown(&token) {
                    Ok(()) if wait_until_offline(Duration::from_secs(10)) => {
                        stopped_response(id, &token)
                    }
                    Ok(()) => error_response(id, "stop_failed", "服务退出超时"),
                    Err(error) => error_response(id, "stop_failed", &error),
                }
            }
        }
        _ => error_response(id, "unknown_action", "不支持的 Native Host 动作"),
    }
}

fn ensure_started(token: &str) -> Result<Health, String> {
    if let Ok(health) = check_health(token) {
        return Ok(health);
    }

    let data_root = data_root()?;
    fs::create_dir_all(&data_root).map_err(|error| error.to_string())?;
    let lock_path = data_root.join("start.lock");
    let lock = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path);

    match lock {
        Ok(mut file) => {
            let _ = writeln!(file, "{}", std::process::id());
            let result = start_server_process(token, &data_root);
            drop(file);
            let _ = fs::remove_file(&lock_path);
            result?;
        }
        Err(_) => {
            if lock_is_stale(&lock_path) {
                let _ = fs::remove_file(&lock_path);
                return ensure_started(token);
            }
        }
    }

    let started = Instant::now();
    let mut last_error = String::from("服务尚未就绪");
    while started.elapsed() < START_TIMEOUT {
        match check_health(token) {
            Ok(health) => return Ok(health),
            Err(error) => last_error = error,
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(format!("服务启动超时：{last_error}"))
}

fn start_server_process(token: &str, data_root: &Path) -> Result<(), String> {
    let install_dir = install_dir()?;
    let node = install_dir.join("runtime").join("node.exe");
    let launcher = install_dir
        .join("server")
        .join("scripts")
        .join("launch.mjs");
    if !node.is_file() {
        return Err(format!("找不到内置 Node：{}", node.display()));
    }
    if !launcher.is_file() {
        return Err(format!("找不到服务启动脚本：{}", launcher.display()));
    }

    let data_dir = data_root.join("data");
    let log_dir = data_root.join("logs");
    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    fs::create_dir_all(&log_dir).map_err(|error| error.to_string())?;

    let allowed_origins =
        fs::read_to_string(install_dir.join("native-host").join("allowed-origins.txt"))
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join(",");
    let capabilities =
        fs::read_to_string(install_dir.join("capabilities.json")).unwrap_or_default();
    let profile =
        json_string_field(&capabilities, "profile").unwrap_or_else(|| "douyin-hybrid".into());
    let has_local_asr = profile == "hybrid" || profile == "douyin-hybrid";

    let mut command = Command::new(&node);
    command
        .arg(&launcher)
        .current_dir(install_dir.join("server"))
        .env("HOST", "127.0.0.1")
        .env("PORT", "18765")
        .env("RUNTIME_AUTH_TOKEN", token)
        .env("DATA_DIR", &data_dir)
        .env("LOG_DIR", &log_dir)
        .env("IDLE_EXIT_MS", "900000")
        .env("VIDEO_ANALYSIS_RUNTIME_MANAGED", "1")
        .env("VIDEO_ANALYSIS_RUNTIME_INSTALL_DIR", &install_dir)
        .env("VIDEO_ANALYSIS_RUNTIME_FFMPEG_DIR", install_dir.join("ffmpeg"))
        .env("RUNTIME_PROFILE", &profile)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    if has_local_asr {
        command
            .env("ASR_PROVIDER", "local")
            .env("LOCAL_ASR_MODEL", "small")
            .env("LOCAL_ASR_DEVICE", "cuda")
            .env("LOCAL_ASR_COMPUTE_TYPE", "float16")
            .env("VIDEO_ANALYSIS_RUNTIME_ASR_DIR", install_dir.join("asr"))
            .env(
                "VIDEO_ANALYSIS_RUNTIME_ASR_RUNNER",
                install_dir
                    .join("asr")
                    .join("runtime")
                    .join("VideoAnalysisAsr.exe"),
            )
            .env(
                "LOCAL_ASR_MODEL_PATH",
                install_dir
                    .join("asr")
                    .join("models")
                    .join("faster-whisper-small"),
            );
    }
    if !allowed_origins.is_empty() {
        command.env("ALLOWED_ORIGINS", allowed_origins);
    }
    let status = command
        .status()
        .map_err(|error| format!("无法执行内置 Node：{error}"))?;

    if !status.success() {
        return Err(format!("服务启动脚本退出：{status}"));
    }
    Ok(())
}

fn check_health(token: &str) -> Result<Health, String> {
    let (status, body) = http_request("GET", "/health", token)?;
    if status != 200 {
        return Err(format!("健康检查返回 HTTP {status}"));
    }
    if !body.contains("\"ok\":true") {
        return Err("健康检查返回异常".into());
    }
    Ok(Health {
        version: json_string_field(&body, "version").unwrap_or_else(|| "unknown".into()),
    })
}

fn request_shutdown(token: &str) -> Result<(), String> {
    let (status, body) = http_request("POST", "/v1/control/shutdown", token)?;
    match status {
        200 => Ok(()),
        409 => Err(json_string_field(&body, "message").unwrap_or_else(|| "仍有分析任务".into())),
        _ => Err(format!("停止服务返回 HTTP {status}")),
    }
}

fn wait_until_offline(timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        let address: SocketAddr = SERVER_ADDR.parse().expect("valid loopback address");
        if TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_err() {
            return true;
        }
        thread::sleep(Duration::from_millis(200));
    }
    false
}

fn http_request(method: &str, path: &str, token: &str) -> Result<(u16, String), String> {
    let address: SocketAddr = SERVER_ADDR
        .parse()
        .map_err(|error| format!("地址错误：{error}"))?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(800))
        .map_err(|error| format!("无法连接本机服务：{error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:18765\r\nAuthorization: Bearer {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| error.to_string())?;
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| error.to_string())?;
    let response = String::from_utf8_lossy(&response);
    let mut lines = response.lines();
    let status_line = lines.next().ok_or_else(|| "本机服务响应为空".to_string())?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| format!("无法解析响应：{status_line}"))?;
    let body = response.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    Ok((status, body))
}

fn data_root() -> Result<PathBuf, String> {
    let local = env::var_os("LOCALAPPDATA").ok_or_else(|| "找不到 LOCALAPPDATA".to_string())?;
    Ok(PathBuf::from(local).join("VideoAnalysisRuntime"))
}

fn install_dir() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("VIDEO_ANALYSIS_RUNTIME_INSTALL_DIR") {
        return Ok(PathBuf::from(value));
    }
    let exe = env::current_exe().map_err(|error| error.to_string())?;
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法确定安装目录".to_string())
}

fn load_or_create_token() -> Result<String, String> {
    let root = data_root()?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let config_path = root.join("config.json");
    if let Ok(text) = fs::read_to_string(&config_path) {
        if let Some(token) = json_string_field(&text, "serverToken") {
            if token.len() >= 32 {
                return Ok(token);
            }
        }
    }

    let token = random_token()?;
    let json = format!(
        "{{\n  \"serverToken\": \"{}\",\n  \"serverUrl\": \"{}\",\n  \"nativeHost\": \"{}\"\n}}\n",
        json_escape(&token),
        SERVER_URL,
        HOST_NAME
    );
    fs::write(&config_path, json).map_err(|error| error.to_string())?;
    Ok(token)
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    let status = unsafe {
        BCryptGenRandom(
            std::ptr::null_mut(),
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(format!("系统随机数生成失败：0x{status:08x}"));
    }
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn lock_is_stale(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > Duration::from_secs(30))
}

fn read_native_message() -> io::Result<Option<String>> {
    let mut length = [0u8; 4];
    match io::stdin().read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > 1024 * 1024 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "消息长度无效"));
    }
    let mut payload = vec![0u8; length];
    io::stdin().read_exact(&mut payload)?;
    String::from_utf8(payload)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn write_native_message(message: &str) -> io::Result<()> {
    let bytes = message.as_bytes();
    let mut stdout = io::stdout().lock();
    stdout.write_all(&(bytes.len() as u32).to_le_bytes())?;
    stdout.write_all(bytes)?;
    stdout.flush()
}

fn json_string_field(input: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let mut rest = &input[input.find(&needle)? + needle.len()..];
    rest = &rest[rest.find(':')? + 1..];
    rest = rest.trim_start();
    if !rest.starts_with('"') {
        return None;
    }
    let mut value = String::new();
    let mut escaped = false;
    for character in rest[1..].chars() {
        if escaped {
            value.push(match character {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            });
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '"' {
            return Some(value);
        } else {
            value.push(character);
        }
    }
    None
}

fn json_escape(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| match character {
            '"' => "\\\"".chars().collect::<Vec<_>>(),
            '\\' => "\\\\".chars().collect(),
            '\n' => "\\n".chars().collect(),
            '\r' => "\\r".chars().collect(),
            '\t' => "\\t".chars().collect(),
            other => vec![other],
        })
        .collect()
}

fn success_response(id: &str, state: &str, token: &str, version: &str) -> String {
    format!(
        "{{\"id\":\"{}\",\"ok\":true,\"state\":\"{}\",\"url\":\"{}\",\"token\":\"{}\",\"version\":\"{}\"}}",
        json_escape(id),
        json_escape(state),
        SERVER_URL,
        json_escape(token),
        json_escape(version)
    )
}

fn offline_response(id: &str, token: &str, error: &str) -> String {
    format!(
        "{{\"id\":\"{}\",\"ok\":true,\"state\":\"stopped\",\"url\":\"{}\",\"token\":\"{}\",\"error\":\"{}\"}}",
        json_escape(id),
        SERVER_URL,
        json_escape(token),
        json_escape(error)
    )
}

fn stopped_response(id: &str, token: &str) -> String {
    format!(
        "{{\"id\":\"{}\",\"ok\":true,\"state\":\"stopped\",\"url\":\"{}\",\"token\":\"{}\"}}",
        json_escape(id),
        SERVER_URL,
        json_escape(token)
    )
}

fn error_response(id: &str, code: &str, error: &str) -> String {
    format!(
        "{{\"id\":\"{}\",\"ok\":false,\"code\":\"{}\",\"error\":\"{}\"}}",
        json_escape(id),
        json_escape(code),
        json_escape(error)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_native_message_fields() {
        let input = r#"{"id":"abc","action":"ensure_started"}"#;
        assert_eq!(json_string_field(input, "id").as_deref(), Some("abc"));
        assert_eq!(
            json_string_field(input, "action").as_deref(),
            Some("ensure_started")
        );
    }

    #[test]
    fn escapes_json_control_characters() {
        assert_eq!(json_escape("a\"b\\c\n"), "a\\\"b\\\\c\\n");
    }
}
