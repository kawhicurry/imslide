import type { CoreEvent } from '../imslide';

export type ToolActivity = {
  id: string; runId: string; name: string; input?: unknown; output?: unknown;
  status: 'running' | 'success' | 'failed' | 'skipped' | 'unknown';
  startedAt?: number; endedAt?: number; error?: string;
};
export const toolLabels: Record<string, string> = {
  get_workspace: '读取工作区', switch_mode: '切换模式', list_decks: '查询文稿', create_deck: '新建文稿', open_deck: '打开文稿', rename_deck: '重命名文稿', duplicate_deck: '复制文稿', delete_deck: '删除文稿', restore_deck: '恢复文稿',
  read_page: '读取页面', update_page: '更新页面', edit_page: '局部修改',
  delete_page: '删除页面', navigate: '切换 / 新增页面', finish: '完成任务',
  apply_voice: '执行语音指令',
};
export const toolStatusLabels: Record<ToolActivity['status'], string> = {
  running: '执行中', success: '成功', failed: '失败', skipped: '已跳过', unknown: '结果未确认',
};
export function reduceToolActivity(items: ToolActivity[], event: CoreEvent | { type: 'disconnected' }): ToolActivity[] {
  if (event.type === 'disconnected' || event.type === 'done' || (event.type === 'error' && event.runId)) {
    return items.map(item => item.status === 'running' && (event.type === 'disconnected' || item.runId === event.runId)
      ? { ...item, status: 'unknown', error: event.type === 'error' ? event.error : '未收到工具结果，无法确认是否完成。' } : item);
  }
  if (event.type !== 'tool' && event.type !== 'tool-result' && event.type !== 'tool-error') return items;
  const id = `${event.runId}:${event.callId}`;
  const existing = items.find(item => item.id === id);
  let item: ToolActivity = existing ?? { id, runId: event.runId, name: event.name, status: 'running' };
  if (event.type === 'tool') {
    item = { ...item, input: event.input, startedAt: item.startedAt ?? event.at };
  } else if (event.type === 'tool-error') {
    item = { ...item, status: 'failed', error: event.error, endedAt: event.at };
  } else {
    const result = event.output && typeof event.output === 'object' ? event.output as Record<string, unknown> : {};
    item = { ...item, output: event.output, endedAt: event.at,
      status: result.skipped === true ? 'skipped' : result.ok === false ? 'failed' : 'success',
      error: typeof result.error === 'string' ? result.error : undefined };
  }
  // Limit this tab's in-memory history; a reconnect does not replay missed events.
  return existing ? items.map(value => value.id === id ? item : value) : [...items, item].slice(-100);
}
export function toolSummary(item: ToolActivity): string {
  const input = item.input && typeof item.input === 'object' ? item.input as Record<string, unknown> : {};
  const pages = input.pages;
  if (pages === 'all') return '全部页面';
  if (Array.isArray(pages)) return `第 ${pages.join('、')} 页`;
  if (typeof pages === 'number') return `第 ${pages} 页`;
  if (item.name === 'navigate') return ({ next: '下一页', previous: '上一页', add: '新增一页', goto: `跳至第 ${input.page} 页` } as Record<string, string>)[String(input.action)] || '调整浏览位置';
  if(item.name==='switch_mode')return ({management:'文稿管理',preview:'预览',presentation:'演示'} as Record<string,string>)[String(input.mode)] || '切换模式';
  if(['get_workspace','list_decks'].includes(item.name))return '文稿库与当前模式';
  if(item.name.endsWith('_deck'))return String(input.title || input.deckId || '文稿');
  if (item.name === 'finish') return '结束本轮操作';
  if (item.name === 'apply_voice') return Array.isArray(input.completed) && input.completed.length ? `处理 ${input.completed.length} 条完整指令` : '等待补充语音';
  const page = typeof input.page === 'number' ? `第 ${input.page} 页` : '当前页';
  return typeof input.title === 'string' ? `${page} · ${input.title}` : page;
}
