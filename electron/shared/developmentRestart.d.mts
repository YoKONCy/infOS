export const DEVELOPMENT_RESTART_EXIT_CODE: number
export function runDevelopmentSessions(
  runOnce: () => Promise<number>,
  isStopping: () => boolean,
  onRestart?: () => void,
): Promise<number>
