import { z } from 'zod';
import { styleIds, type PresentationStyle } from './presentation-styles.ts';
export const presentationStyleSchema = z.enum(styleIds);
export const modeSchema = z.enum(['management', 'preview', 'presentation']);
export type WorkspaceMode = z.infer<typeof modeSchema>;
export type DeckSummary = { id: string; title: string; pageCount: number; updatedAt: string; deletedAt?: string; style?: PresentationStyle };
export type WorkspaceState = { mode: WorkspaceMode; activeDeckId: string | null; workspaceRevision: number; decks: DeckSummary[] };
const title = z.string().trim().min(1).max(120);
const target = { deckId: z.string().min(1).max(80) };
export const workspaceActions = [
  z.object({ tool: z.literal('get_workspace') }),
  z.object({ tool: z.literal('switch_mode'), mode: modeSchema }),
  z.object({ tool: z.literal('list_decks'), query: z.string().max(120).optional(), deleted: z.boolean().default(false) }),
  z.object({ tool: z.literal('create_deck'), title, style: presentationStyleSchema.optional().describe('生成风格：business商务稳重、technology科技未来、academic学术科研、humanities创意人文、minimal极简汇报') }),
  z.object({ tool: z.literal('open_deck'), ...target }),
  z.object({ tool: z.literal('rename_deck'), ...target, title }),
  z.object({ tool: z.literal('duplicate_deck'), ...target, title: title.optional() }),
  z.object({ tool: z.literal('delete_deck'), ...target }),
  z.object({ tool: z.literal('restore_deck'), ...target }),
] as const;
export const workspaceActionSchema = z.discriminatedUnion('tool', workspaceActions);
export type WorkspaceAction = z.infer<typeof workspaceActionSchema>;
export const workspaceDescriptions: Record<WorkspaceAction['tool'], string> = {
  get_workspace: '读取当前模式、活动文稿ID、版本和文稿列表。所有模式可用。',
  switch_mode: '显式切换management管理、preview预览、presentation演示。所有模式可用；预览/演示需已有活动文稿。',
  list_decks: '管理模式：列出文稿ID、标题、页数和修改时间；query搜索标题，deleted=true查询回收站。同名时返回候选，不猜测ID。',
  create_deck: '管理模式：新建一份含一张空白页的文稿，返回deckId，仍停留管理页。',
  open_deck: '管理模式：用明确deckId打开文稿，并进入预览模式。',
  rename_deck: '管理模式：重命名指定文稿。',
  duplicate_deck: '管理模式：复制指定文稿，新文稿和页面使用新ID，返回deckId，不自动打开。',
  delete_deck: '管理模式：仅按用户明确要求删除指定文稿，移入回收站，可恢复。',
  restore_deck: '管理模式：恢复回收站中的文稿，不自动打开。',
};
export class WorkspaceError extends Error {
  constructor(public code: string, message: string, public details: Record<string, unknown> = {}) { super(message); }
  result() { return { ok: false as const, code: this.code, error: this.message, ...this.details }; }
}
export function checkMode(mode: WorkspaceMode, tool: string, input: { action?: string } = {}) {
  const allowed: WorkspaceMode[] = ['get_workspace','switch_mode','finish','apply_voice'].includes(tool) ? ['management','preview','presentation']
    : tool in workspaceDescriptions ? ['management']
    : tool === 'read_page' || (tool === 'navigate' && input.action !== 'add') ? ['preview','presentation'] : ['preview'];
  if (!allowed.includes(mode)) throw new WorkspaceError('TOOL_UNAVAILABLE_IN_MODE', '当前模式不可用，请先显式调用 switch_mode 切换模式。', { currentMode: mode, allowedModes: allowed, tool });
}
