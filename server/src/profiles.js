const PROFILE_DEFINITIONS = {
  cloud: {
    asr: ['dashscope', 'openai'],
    localAsr: false,
    connectors: [],
  },
  hybrid: {
    asr: ['dashscope', 'openai', 'local'],
    localAsr: true,
    connectors: [],
  },
  'douyin-cloud': {
    asr: ['dashscope', 'openai'],
    localAsr: false,
    connectors: ['douyin'],
  },
  'douyin-hybrid': {
    asr: ['dashscope', 'openai', 'local'],
    localAsr: true,
    connectors: ['douyin'],
  },
};

export function resolveRuntimeProfile(value = process.env.RUNTIME_PROFILE) {
  const requested = String(value || 'cloud').trim().toLowerCase();
  const definition = PROFILE_DEFINITIONS[requested];
  if (!definition) {
    throw new Error(
      `未知 RUNTIME_PROFILE=${requested}，可选值：${Object.keys(PROFILE_DEFINITIONS).join(', ')}`,
    );
  }
  return {
    name: requested,
    ...definition,
    llm: ['openai-compatible'],
    media: ['probe', 'extract_audio', 'extract_frames'],
    operations: [
      'media.probe',
      'media.extract_audio',
      'media.extract_frames',
      'asr.transcribe',
      'llm.generate',
      'video.analyze',
      'pipeline.run',
      ...(definition.connectors.includes('douyin')
        ? ['connector.douyin.import']
        : []),
    ],
  };
}

export function allRuntimeProfiles() {
  return Object.keys(PROFILE_DEFINITIONS);
}
