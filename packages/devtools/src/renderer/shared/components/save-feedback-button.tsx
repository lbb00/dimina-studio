import { Button } from './ui/button'

export function SaveFeedbackButton({ onSave, saved }: { onSave: () => void; saved: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <Button size="sm" onClick={onSave}>保存</Button>
      {saved && <span className="text-[11px] text-status-success">已保存</span>}
    </div>
  )
}
