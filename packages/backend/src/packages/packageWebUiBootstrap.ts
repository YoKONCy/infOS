/** 按 HTML 标签定位，跳过注释并保留带引号的属性。 */
export function packageWebUiHeadEnd(html: string): number {
  const tags = /<!--[\s\S]*?-->|<head\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi
  for (const match of html.matchAll(tags)) {
    if (!match[0].startsWith('<!--')) return match.index! + match[0].length
  }
  throw new Error('PACKAGE_WEB_UI_INVALID')
}

/** 注入隔离页面的最小 SDK；凭据、服务端会话和宿主接口均留在父页面。 */
export function packageWebUiBootstrap(channel: string): string {
  const config = JSON.stringify(channel).replaceAll('<', '\\u003c')
  return `<script>(()=>{
    'use strict';
    const channel=${config}, protocol='infos.package-ui.v1', pending=new Map(), listeners=new Set();
    let sequence=0, context=Object.freeze({theme:'dark',locale:'zh-CN'}), closed=false;
    const send=(type,value={})=>parent.postMessage({protocol,channel,type,...value},'*');
    const finish=(id,error,value)=>{const item=pending.get(id);if(!item)return;pending.delete(id);clearTimeout(item.timer);item.cleanup();error?item.reject(new Error(error)):item.resolve(value);};
    addEventListener('message',event=>{
      const m=event.data;
      if(event.source!==parent||!m||m.protocol!==protocol||m.channel!==channel)return;
      if(m.type==='context'){
        context=Object.freeze({theme:m.context.theme==='light'?'light':'dark',locale:String(m.context.locale)});
        document.documentElement.dataset.theme=context.theme;
        document.documentElement.style.colorScheme=context.theme;
        document.documentElement.lang=context.locale;
        for(const listener of listeners){try{listener(context);}catch{}}
      }else if(m.type==='result')finish(m.id,null,m.value);
      else if(m.type==='error')finish(m.id,String(m.message));
      else if(m.type==='progress'){try{pending.get(m.id)?.progress?.(m.value);}catch{}}
      else if(m.type==='closed'){closed=true;for(const id of pending.keys())finish(id,String(m.message));}
    });
    Object.defineProperty(globalThis,'infosPlugin',{value:Object.freeze({
      get context(){return context;},
      onContext(listener){listeners.add(listener);listener(context);return()=>listeners.delete(listener);},
      call(action,input=null,options={}){
        if(closed)return Promise.reject(new Error('PACKAGE_WEB_UI_UNAVAILABLE'));
        if(pending.size>=8)return Promise.reject(new Error('PACKAGE_WEB_UI_BUSY'));
        if(options.signal?.aborted)return Promise.reject(options.signal.reason);
        const id=String(++sequence);
        return new Promise((resolve,reject)=>{
          const abort=()=>{send('cancel',{id});finish(id,'PACKAGE_WEB_UI_CANCELLED');};
          const timer=setTimeout(()=>{send('cancel',{id});finish(id,'PACKAGE_WEB_UI_TIMEOUT');},65000);
          pending.set(id,{resolve,reject,timer,progress:options.onProgress,cleanup:()=>options.signal?.removeEventListener('abort',abort)});
          options.signal?.addEventListener('abort',abort,{once:true});
          try{send('call',{id,action,input});}catch{finish(id,'PACKAGE_WEB_UI_INPUT_INVALID');}
        });
      }
    }),writable:false,configurable:false});
    addEventListener('pagehide',()=>{for(const id of pending.keys()){send('cancel',{id});finish(id,'PACKAGE_WEB_UI_CANCELLED');}});
    let booted=false;
    addEventListener('DOMContentLoaded',()=>{booted=true;send('ready');},{once:true});
    addEventListener('error',event=>{
      if(!booted&&(event.target===globalThis||event.target?.tagName==='SCRIPT'))send('failed');
    },true);
  })();</script>`
}
