#define MyAppName "Video Analysis Runtime"
#define MyAppPublisher "Video Analysis Runtime"
#define MyAppExeName "VideoAnalysisRuntimeHost.exe"

#ifndef MyAppVersion
  #define MyAppVersion "1.0.1"
#endif
#ifndef Profile
  #define Profile "douyin-hybrid"
#endif
#ifndef HasDouyin
  #define HasDouyin 0
#endif
#if HasDouyin == "1"
  #ifndef ChromeExtensionId
    #error "Douyin Profile requires /DChromeExtensionId"
  #endif
  #ifndef EdgeExtensionId
    #define EdgeExtensionId ChromeExtensionId
  #endif
#endif

[Setup]
AppId={{F18B55DD-06F1-48CC-A192-4DC80F95B3E6}
AppName={#MyAppName} ({#Profile})
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\VideoAnalysisRuntime
DefaultGroupName=Video Analysis Runtime
DisableProgramGroupPage=yes
OutputDir=..\dist\installer
OutputBaseFilename=Video-Analysis-Runtime-{#MyAppVersion}-win-x64-{#Profile}
Compression=lzma2/fast
SolidCompression=no
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UsePreviousAppDir=yes
UninstallDisplayIcon={app}\{#MyAppExeName}
CloseApplications=no
RestartApplications=no

[Files]
Source: "..\dist\desktop\{#Profile}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\查看服务日志"; Filename: "{localappdata}\VideoAnalysisRuntime\logs"

#if HasDouyin == "1"
[Registry]
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\com.videoanalysis.runtime"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host\com.videoanalysis.runtime.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\com.videoanalysis.runtime"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host\com.videoanalysis.runtime.json"; Flags: uninsdeletekey
#endif

[UninstallRun]
Filename: "{app}\{#MyAppExeName}"; Parameters: "--action stop"; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId: "StopVideoAnalysisRuntime"

[UninstallDelete]
Type: files; Name: "{app}\native-host\com.videoanalysis.runtime.json"

[Code]
function JsonEscape(Value: String): String;
begin
  Result := Value;
  StringChangeEx(Result, '\', '\\', True);
  StringChangeEx(Result, '"', '\"', True);
end;

procedure WriteNativeHostManifest;
var
  ManifestDir, ManifestPath, OriginsPath, HostPath: String;
  ManifestLines, OriginLines: TArrayOfString;
begin
#if HasDouyin == "1"
  ManifestDir := ExpandConstant('{app}\native-host');
  ManifestPath := ManifestDir + '\com.videoanalysis.runtime.json';
  OriginsPath := ManifestDir + '\allowed-origins.txt';
  HostPath := ExpandConstant('{app}\{#MyAppExeName}');
  ForceDirectories(ManifestDir);
  SetArrayLength(ManifestLines, 10);
  ManifestLines[0] := '{';
  ManifestLines[1] := '  "name": "com.videoanalysis.runtime",';
  ManifestLines[2] := '  "description": "Video Analysis Runtime Host",';
  ManifestLines[3] := '  "path": "' + JsonEscape(HostPath) + '",';
  ManifestLines[4] := '  "type": "stdio",';
  ManifestLines[5] := '  "allowed_origins": [';
  ManifestLines[6] := '    "chrome-extension://{#ChromeExtensionId}/",';
  ManifestLines[7] := '    "chrome-extension://{#EdgeExtensionId}/"';
  ManifestLines[8] := '  ]';
  ManifestLines[9] := '}';
  SaveStringsToUTF8FileWithoutBOM(ManifestPath, ManifestLines, False);
  SetArrayLength(OriginLines, 2);
  OriginLines[0] := 'chrome-extension://{#ChromeExtensionId}/';
  OriginLines[1] := 'chrome-extension://{#EdgeExtensionId}/';
  SaveStringsToUTF8FileWithoutBOM(OriginsPath, OriginLines, False);
#endif
end;

procedure StopHost(HostPath: String);
var ResultCode: Integer;
begin
  if FileExists(HostPath) then
    Exec(HostPath, '--action stop', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  StopHost(ExpandConstant('{app}\{#MyAppExeName}'));
  StopHost(ExpandConstant('{localappdata}\Programs\BrowseLife\BrowseLifeNativeHost.exe'));
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then WriteNativeHostManifest;
end;
