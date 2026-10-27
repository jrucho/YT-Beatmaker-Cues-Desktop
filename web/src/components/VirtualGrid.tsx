import {useVirtualizer} from '@tanstack/react-virtual';
import {defaultRangeExtractor} from '@tanstack/virtual-core';
import {Fragment,useCallback,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode,type RefCallback} from 'react';

export interface VirtualCardProps{style?:CSSProperties;ref?:RefCallback<HTMLDivElement>;'data-index':number;'aria-posinset':number;'aria-setsize':number;role:'listitem'}
interface Props<T>{items:T[];className:string;busy?:boolean;itemKey(item:T,index:number):string;renderItem(item:T,index:number,props:VirtualCardProps):ReactNode;empty?:ReactNode}
export function VirtualGrid<T>(props:Props<T>){
  if(props.items.length<=60)return <div className={props.className} aria-busy={props.busy} role="list">{props.items.map((item,index)=><Fragment key={props.itemKey(item,index)}>{props.renderItem(item,index,{'data-index':index,'aria-posinset':index+1,'aria-setsize':props.items.length,role:'listitem'})}</Fragment>)}{props.empty}</div>;
  return <WindowedGrid {...props}/>;
}
function WindowedGrid<T>({items,className,busy,itemKey,renderItem}:Props<T>){
  const root=useRef<HTMLDivElement>(null),[metrics,setMetrics]=useState({columns:className.includes('bm-list')?1:3,width:400,gap:12});
  const [focused,setFocused]=useState<number|null>(null);
  const [rowHeight,setRowHeight]=useState(className.includes('bm-list')?60:180);
  const getKey=useCallback((index:number)=>itemKey(items[index]!,index),[items,itemKey]);
  const rangeExtractor=useCallback((range:Parameters<typeof defaultRangeExtractor>[0])=>{const rows=defaultRangeExtractor(range);if(focused!==null&&focused<items.length&&!rows.includes(focused))rows.push(focused);return rows.sort((a,b)=>a-b);},[focused,items.length]);
  const virtual=useVirtualizer<HTMLDivElement,HTMLDivElement>({count:items.length,getScrollElement:()=>root.current,estimateSize:()=>rowHeight,overscan:9,lanes:metrics.columns,gap:metrics.gap,getItemKey:getKey,rangeExtractor,initialRect:{width:400,height:400}});
  useLayoutEffect(()=>{
    const element=root.current;if(!element)return;
    const update=()=>{const css=getComputedStyle(element),columns=css.gridTemplateColumns==='none'?1:css.gridTemplateColumns.split(/\s+/).length;
      const width=element.clientWidth-(parseFloat(css.paddingLeft)||0)-(parseFloat(css.paddingRight)||0),gap=parseFloat(css.columnGap)||0;
      if(width<=0)return;
      setMetrics(previous=>previous.columns===columns&&previous.width===width&&previous.gap===gap?previous:{columns,width,gap});};
    update();const observer=new ResizeObserver(update);observer.observe(element);return()=>observer.disconnect();
  },[className]);
  useLayoutEffect(()=>{const card=root.current?.querySelector<HTMLElement>('[data-index]');if(card){const height=card.getBoundingClientRect().height;if(height>0)setRowHeight(previous=>Math.abs(previous-height)>.1?height:previous);}});
  useLayoutEffect(()=>{virtual.measure();root.current?.querySelectorAll<HTMLDivElement>('[data-index]').forEach(card=>virtual.measureElement(card));},[virtual,metrics.columns,metrics.width,rowHeight]);
  const width=(metrics.width-metrics.gap*(metrics.columns-1))/metrics.columns;
  return <div ref={root} className={className} aria-busy={busy} role="list" data-virtual-grid="true"
    onFocusCapture={event=>{const card=(event.target as HTMLElement).closest<HTMLElement>('[data-index]');if(card)setFocused(Number(card.dataset.index));}}
    onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setFocused(null);}}
    onKeyDown={event=>{if(event.altKey||event.ctrlKey||event.metaKey)return;const card=(event.target as HTMLElement).closest<HTMLElement>('[data-index]');if(!card)return;
      const index=Number(card.dataset.index),step=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:event.key==='ArrowDown'?metrics.columns:event.key==='ArrowUp'?-metrics.columns:0;
      const target=event.key==='Home'?0:event.key==='End'?items.length-1:step?Math.max(0,Math.min(items.length-1,index+step)):null;if(target===null)return;
      event.preventDefault();event.stopPropagation();setFocused(target);virtual.scrollToIndex(target,{align:'auto'});requestAnimationFrame(()=>root.current?.querySelector<HTMLElement>(`[data-index="${target}"] button`)?.focus({preventScroll:true}));
    }}>
    <div style={{height:virtual.getTotalSize(),position:'relative',gridColumn:'1/-1',width:'100%'}}>
      {virtual.getVirtualItems().map(card=><Fragment key={card.key}>{renderItem(items[card.index]!,card.index,{'data-index':card.index,'aria-posinset':card.index+1,'aria-setsize':items.length,role:'listitem',ref:virtual.measureElement,style:{position:'absolute',top:0,left:card.lane*(width+metrics.gap),width,transform:`translateY(${card.start}px)`}})}</Fragment>)}
    </div>
  </div>;
}
