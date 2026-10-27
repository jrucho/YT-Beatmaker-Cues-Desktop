// Opt-in live provider diagnostic. Run with server's tsx loader; never imports a playlist into the user's library.
import {performance} from 'node:perf_hooks';
import {config} from '../server/src/config.ts';
import {getPlaylist, searchPlaylists} from '../server/src/playlists.ts';

const value=process.argv[2];
if(!value)throw new Error('Usage: node --import ./server/node_modules/tsx/dist/loader.mjs scripts/profile-live-playlist.mjs <playlist URL or ID>');
const started=performance.now(), requests=[];
const elapsed=()=>Math.round(performance.now()-started);
const deadline=AbortSignal.timeout(90_000);
config.fetch=async(input,init)=>{
  const requestStarted=performance.now();
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  const request={host:url.host,path:url.pathname,startedMs:elapsed()};requests.push(request);
  try{
    const response=await fetch(input,{...init,signal:AbortSignal.any([deadline,...(init?.signal?[init.signal]:[])])});
    request.status=response.status;return response;
  }catch(error){request.error=error.message;throw error;}
  finally{request.headersMs=Math.round(performance.now()-requestStarted);}
};
const timer=setTimeout(()=>{console.error('Live playlist diagnostic exceeded 95 seconds');process.exit(1);},95_000);
try{
  const metadata=await searchPlaylists(value);
  const metadataMs=elapsed(),progress=[];
  const playlist=await getPlaylist(value,undefined,{signal:deadline,onProgress:page=>progress.push({elapsedMs:elapsed(),tracks:page.tracks.length,complete:page.complete})});
  const completeMs=elapsed(),coldRequestCount=requests.length,warmStarted=performance.now();
  const warm=await getPlaylist(value,undefined,{signal:deadline});
  const selectedId=/^https?:/.test(value)?new URL(value).searchParams.get('v'):undefined;
  const selected=playlist.tracks.find(track=>track.id===selectedId)||playlist.tracks[0];
  console.log(JSON.stringify({conditions:'Live server provider on this Mac/network; excludes audio download/decode, WebView rendering and device output latency',playlist:{id:playlist.id,title:metadata[0]?.title,tracks:playlist.tracks.length,truncated:playlist.truncated,selectedTrack:selected&&{id:selected.id,title:selected.title,duration:selected.duration}},metadataMs,completeMs,progress,coldRequestCount,warm:{elapsedMs:Math.round(performance.now()-warmStarted),tracks:warm.tracks.length,requests:requests.length-coldRequestCount},requests},null,2));
}catch(error){console.error(JSON.stringify({error:error.message,elapsedMs:elapsed(),requests},null,2));process.exitCode=1;}
finally{clearTimeout(timer);}
