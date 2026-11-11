import { ArrowCounterClockwiseIcon, ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useEditHistory } from "../mobile/editHistory";
import { iosPadLayoutEnabled } from "../mobile/padLayout";
import { toast } from "../stores/ui";

export function EditHistoryControls() {
  const state = useEditHistory();
  if (!iosPadLayoutEnabled() || (!state.past.length && !state.future.length)) return null;
  return <span className="ios-edit-history flex shrink-0 gap-0.5">
    <button type="button" aria-label="Undo edit" title={`Undo ${state.past.at(-1)?.label ?? ''}`} disabled={state.busy || !state.past.length} className="grid size-7 place-items-center rounded-full bg-surface-2 text-fg-2 disabled:opacity-30" onClick={() => void state.undo().catch(error => toast(error.message, 'error'))}><ArrowCounterClockwiseIcon size={15}/></button>
    <button type="button" aria-label="Redo edit" title={`Redo ${state.future.at(-1)?.label ?? ''}`} disabled={state.busy || !state.future.length} className="grid size-7 place-items-center rounded-full bg-surface-2 text-fg-2 disabled:opacity-30" onClick={() => void state.redo().catch(error => toast(error.message, 'error'))}><ArrowClockwiseIcon size={15}/></button>
  </span>;
}
