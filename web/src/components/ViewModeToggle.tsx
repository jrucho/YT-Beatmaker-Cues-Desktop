import { GridFourIcon, ListBulletsIcon } from "@phosphor-icons/react";
import { useT } from "../i18n";

export function ViewModeToggle({value,onChange,label}:{value:"grid"|"list";onChange(value:"grid"|"list"):void;label:string}) {
  const t=useT();
  return <div role="group" aria-label={label} className="view-mode-toggle">
    <button type="button" aria-label={t.common.gridView} title={t.common.gridView} aria-pressed={value==='grid'} onClick={()=>onChange('grid')}><GridFourIcon size={17}/></button>
    <button type="button" aria-label={t.common.listView} title={t.common.listView} aria-pressed={value==='list'} onClick={()=>onChange('list')}><ListBulletsIcon size={17}/></button>
  </div>;
}
