export type RenderFailure = {
  stage: 'renderer' | 'snapshot'; message: string; revision: number;
  pageId?: string; snapshot?: string;
};
export function renderFailure(error: unknown, details: Omit<RenderFailure, 'message'>): RenderFailure {
  return { ...details, message: (error instanceof Error ? error.message : String(error || '渲染失败')).slice(0, 1000) };
}
