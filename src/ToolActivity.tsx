import { Check, ChevronRight, CircleHelp, LoaderCircle, SkipForward, Wrench, X } from 'lucide-react';
import { toolLabels, toolStatusLabels, toolSummary, type ToolActivity as Activity } from './tool-activity';

const icons = { running: LoaderCircle, success: Check, failed: X, skipped: SkipForward, unknown: CircleHelp };
export function ToolActivity({ items, running, connected }: { items: Activity[]; running: boolean; connected: boolean }) {
  return <section className="tool-panel" aria-label="Agent 操作记录">
    <div className="tool-heading"><Wrench size={14}/><strong>Agent 操作</strong><span>{items.length ? `${items.length} 次调用` : '等待指令'}</span></div>
    <div className="tool-session-status" role="status">{!connected ? '连接中断 · 正在重连' : running ? 'Agent 正在处理…' : items.length ? '当前空闲' : '工具调用后会在这里显示'}</div>
    {items.length > 0 && <div className="tool-list">{[...items].reverse().map(item => {
      const Icon = icons[item.status];
      const duration = item.startedAt !== undefined && item.endedAt !== undefined ? Math.max(0, item.endedAt - item.startedAt) : undefined;
      return <details key={item.id} className={`tool-entry tool-${item.status}`}>
        <summary><Icon size={14} className={item.status === 'running' ? 'tool-spinner' : ''}/><span className="tool-description"><strong>{toolLabels[item.name] || item.name}</strong><span>{toolSummary(item)}</span></span><span className="tool-status">{toolStatusLabels[item.status]}</span><ChevronRight size={13} className="tool-chevron"/></summary>
        <div className="tool-detail"><div className="tool-meta"><code>{item.name}</code>{duration !== undefined && <span>{duration < 1000 ? `${duration} ms` : `${(duration / 1000).toFixed(1)} s`}</span>}</div>
          {item.error && <p className="tool-error-text">{item.error}</p>}
          <h4>调用参数</h4><pre>{item.input === undefined ? '未收到参数（可能在连接中断期间调用）' : JSON.stringify(item.input, null, 2)}</pre>
          <h4>执行结果</h4><pre>{item.output !== undefined ? JSON.stringify(item.output, null, 2) : item.status === 'running' ? '等待工具返回…' : item.error || '未收到结果'}</pre>
        </div>
      </details>;
    })}</div>}
    {items.length > 0 && <p className="tool-history-note">本次打开期间最近 100 次调用 · 最新在上</p>}
  </section>;
}
