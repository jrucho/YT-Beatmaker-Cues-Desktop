import {useVirtualizer} from '@tanstack/react-virtual';
import {defaultRangeExtractor} from '@tanstack/virtual-core';
import {Fragment, useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefCallback, type RefObject} from 'react';
import {centerInScrollArea, scrollParent} from '../lib/scroll';

export interface VirtualRowProps {
  style?: CSSProperties;
  ref?: RefCallback<HTMLLIElement>;
  'data-index': number;
  'aria-posinset': number;
  'aria-setsize': number;
}
export type ListReveal = { key: string; index: number };

interface Props<T> {
  items: T[];
  itemKey(item: T,index: number): string;
  renderItem(item: T,index: number,props: VirtualRowProps): ReactNode;
  className?: string;
  label?: string;
  reveal?: ListReveal;
}

export function VirtualList<T>(props: Props<T>) {
  const list = useRef<HTMLUListElement>(null);
  const [handled, setHandled] = useState<string>();
  const target = props.reveal?.key !== handled ? props.reveal : undefined;
  const { key, index } = target ?? {};
  useLayoutEffect(() => {
    if (!key || index === undefined) return;
    let frame = 0, attempts = 0, centered = 0;
    const reveal = () => {
      const row = list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
      if (row) {
        centered = centerInScrollArea(row) ? centered + 1 : 0;
        // Allow measured row heights to settle, then leave the scroll position to the user.
        if (centered >= 2) return setHandled(key);
      }
      if (++attempts < 8) frame = requestAnimationFrame(reveal);
      else setHandled(key);
    };
    // Start after the route's top reset and the virtualizer's layout pass.
    frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [key, index]);
  if(props.items.length>60)return <WindowedList {...props} list={list} reveal={target}/>;
  return <ul ref={list} className={props.className} aria-label={props.label}>{props.items.map((item,index)=><Fragment key={props.itemKey(item,index)}>{props.renderItem(item,index,{'data-index':index,'aria-posinset':index+1,'aria-setsize':props.items.length})}</Fragment>)}</ul>;
}

function WindowedList<T>({items,itemKey,renderItem,className,label,reveal,list}:Props<T>&{list:RefObject<HTMLUListElement|null>}){
  const [parent,setParent]=useState<HTMLElement|null>(null);
  const [margin,setMargin]=useState(0);
  const [paddingEnd,setPaddingEnd]=useState(0);
  const [focused,setFocused]=useState<number|null>(null);
  const revealIndex = reveal?.index;
  const getKey=useCallback((index:number)=>itemKey(items[index]!,index),[items,itemKey]);
  const rangeExtractor=useCallback((range:Parameters<typeof defaultRangeExtractor>[0])=>{
    const result=defaultRangeExtractor(range);
    // Materialize the destination even when it is far outside the visible window.
    if(revealIndex!==undefined&&revealIndex>=0&&revealIndex<items.length&&!result.includes(revealIndex))result.push(revealIndex);
    if(focused!==null&&focused<items.length&&!result.includes(focused))result.push(focused);
    return result.sort((a,b)=>a-b);
  },[focused,items.length,revealIndex]);
  const virtual=useVirtualizer<HTMLElement,HTMLLIElement>({
    count:items.length,getScrollElement:()=>parent,estimateSize:()=>56,overscan:7,
    // The parent supplies the bottom space; include it in scroll limits without duplicating it in the DOM height.
    getItemKey:getKey,scrollMargin:margin,scrollPaddingEnd:paddingEnd,paddingEnd,rangeExtractor,
    initialRect:{width:400,height:600},
  });
  useLayoutEffect(()=>{
    setParent(scrollParent(list.current));
  },[list]);
  useLayoutEffect(()=>{
    if(list.current&&parent){setMargin(list.current.getBoundingClientRect().top-parent.getBoundingClientRect().top+parent.scrollTop-parent.clientTop);setPaddingEnd(parseFloat(getComputedStyle(parent).paddingBottom)||0);}
  });
  return <ul ref={list} className={className} aria-label={label} data-virtual-list="true"
    style={{height:virtual.getTotalSize()-paddingEnd,position:'relative'}}
    onFocusCapture={event=>{const row=(event.target as HTMLElement).closest<HTMLElement>('[data-index]');if(row)setFocused(Number(row.dataset.index));}}
    onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setFocused(null);}}
    onKeyDown={event=>{
      if(event.altKey||event.ctrlKey||event.metaKey)return;
      const row=(event.target as HTMLElement).closest<HTMLElement>('[data-index]');if(!row)return;
      const index=Number(row.dataset.index),target=event.key==='ArrowDown'?Math.min(items.length-1,index+1):event.key==='ArrowUp'?Math.max(0,index-1):event.key==='Home'?0:event.key==='End'?items.length-1:null;
      if(target===null)return;event.preventDefault();event.stopPropagation();
      setFocused(target);virtual.scrollToIndex(target,{align:'auto'});
      requestAnimationFrame(()=>list.current?.querySelector<HTMLElement>(`[data-index="${target}"] button`)?.focus({preventScroll:true}));
    }}>
    {virtual.getVirtualItems().map(row=><Fragment key={row.key}>{renderItem(items[row.index]!,row.index,{
      'data-index':row.index,'aria-posinset':row.index+1,'aria-setsize':items.length,
      ref:virtual.measureElement,style:{position:'absolute',top:0,left:0,width:'100%',transform:`translateY(${row.start-margin}px)`},
    })}</Fragment>)}
  </ul>;
}
