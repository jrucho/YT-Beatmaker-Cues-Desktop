// Opt-in real YouTube transfer/track-switch test in Electron; uses isolated library/user data.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import {_electron} from 'playwright';
const root=path.resolve(import.meta.dirname,'..');
const require=createRequire(path.join(root,'desktop/package.json'));
const electron=require('electron');
const work=await mkdtemp(path.join(tmpdir(),'beatmaker-live-'));
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const server=spawn(process.execPath,[path.join(root,'server/node_modules/tsx/dist/cli.mjs'),path.join(root,'server/src/index.ts')],
 {cwd:root,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',MUSIKE_DATA_DIR:path.join(work,'data')},stdio:['ignore','pipe','pipe']});
let logs='';server.stdout.on('data',data=>logs+=data);server.stderr.on('data',data=>logs+=data);
let app;
try {
 for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
 const main=path.join(work,'main.cjs');
 // Electron supplies its built-in module independently of the executable's filesystem path.
 await writeFile(main,`const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(work,'electron'))});app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');app.whenReady().then(()=>{const w=new BrowserWindow({width:1200,height:900});w.loadURL('http://127.0.0.1:${port}/?workspace=beatmaker')});`);
 app=await _electron.launch({executablePath:electron,args:[main]});
 const page=await app.firstWindow();
 await page.evaluate(async()=>{for(const registration of await navigator.serviceWorker.getRegistrations())await registration.unregister();});
 await page.context().addInitScript(()=>{Object.defineProperty(navigator,'serviceWorker',{value:undefined});});
 await page.reload();
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/search?*',route=>route.fulfill({json:{tracks:[
   {id:'00ud2TX3aFE',title:'Live test one',artist:'Test',duration:230,kind:'song',thumb:'',art:''},
   {id:'dQw4w9WgXcQ',title:'Live test two',artist:'Test',duration:213,kind:'song',thumb:'',art:''}
 ]}}));
 await page.getByRole('textbox',{name:'Discover samples search'}).fill('live test');
 await page.getByRole('button',{name:'START DIGGING'}).click();
 await page.getByRole('button',{name:'Load Live test one into studio',exact:true}).first().click();
 await page.locator('.bm-app[data-engine-ready="true"]').waitFor();
 await page.waitForFunction(()=>window.musikeBeatmakerHost?.media().currentTime>1&&!window.musikeBeatmakerHost.media().paused,null,{timeout:75000});
 console.log('PASS: first real YouTube song plays in Electron');
 await page.getByRole('textbox',{name:'Search music',exact:true}).fill('live test');
 await page.getByRole('button',{name:'Search YouTube Music',exact:true}).click();
 await page.getByRole('button',{name:'Play Live test two',exact:true}).click();
 assert(await page.locator('.bm-play').getAttribute('aria-busy')==='true','Track switching displays loading feedback');
 await page.waitForFunction(()=>window.musikeBeatmakerHost?.media().src.includes('dQw4w9WgXcQ')&&window.musikeBeatmakerHost.media().currentTime>1&&!window.musikeBeatmakerHost.media().paused,null,{timeout:75000});
 console.log('PASS: switching to a second real YouTube song plays in Electron');
 await page.getByRole('button',{name:'Play Live test one',exact:true}).click();
 await page.waitForFunction(()=>window.musikeBeatmakerHost?.media().src.includes('00ud2TX3aFE')&&window.musikeBeatmakerHost.media().currentTime>1&&!window.musikeBeatmakerHost.media().paused,null,{timeout:75000});
 assert.equal(await page.locator('.bm-footer').count(),0);
 assert(!(await page.locator('.bm-brand').innerText()).includes('MUSIKE'));
 assert.deepEqual(errors,[]);
 console.log('PASS: switching back, minimal branding and no technical footer');
} catch(error){console.error(logs);throw error;}
finally{await app?.close();server.kill();await rm(work,{recursive:true,force:true});}
