// Documentation capture only. Usage: node evidence/tools/record-demos.mjs PLAYWRIGHT_MODULE [CHROMIUM_EXECUTABLE].
// Setup uses the checked-in public test authority in an isolated browser bundle, never real deployment credentials.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.argv[2] || 'playwright');
const fixture = JSON.parse(await readFile(new URL('../../configurator/src/noise-vectors.json', import.meta.url)));
const root = new URL('../checks/demos/', import.meta.url).pathname;
await mkdir(root, { recursive: true });
const browser = await chromium.launch({headless:true,...(process.argv[3] && {executablePath:process.argv[3]})});
async function record(name, width, height) {
 const output=`/private/tmp/teton-gif-${name}`;
 await mkdir(output,{recursive:true});
 const context=await browser.newContext({viewport:{width,height},recordVideo:{dir:output,size:{width,height}}});
 await context.addInitScript(() => {
  addEventListener('DOMContentLoaded', () => {
   const pointer=document.createElement('div');
   pointer.setAttribute('aria-hidden','true');
   pointer.id='demo-pointer';
   pointer.style.cssText='position:fixed;left:18px;top:18px;width:30px;height:36px;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 1px 2px #555)';
   pointer.innerHTML='<svg width="30" height="36" viewBox="0 0 30 36"><path d="M3 2L3 28L10 21L15 33L21 30L16 19L27 19Z" fill="#111" stroke="white" stroke-width="2"/></svg>';
   const ring=document.createElement('div');
   ring.id='demo-click';
   ring.style.cssText='position:fixed;width:42px;height:42px;border:3px solid #2563eb;background:#2563eb22;border-radius:50%;z-index:2147483646;pointer-events:none;opacity:0;transition:opacity .2s';
   document.body.append(ring,pointer);
   addEventListener('pointermove',e=>{pointer.style.left=e.clientX+'px';pointer.style.top=e.clientY+'px'});
   addEventListener('pointerdown',e=>{ring.style.left=(e.clientX-21)+'px';ring.style.top=(e.clientY-21)+'px';ring.style.opacity='1';setTimeout(()=>{ring.style.opacity='0'},450)});
  });
 });
 const page=await context.newPage();
 const tap=async locator=>{
  await locator.scrollIntoViewIfNeeded();
  const box=await locator.boundingBox();
  assert(box,'click target must have bounds');
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2,{steps:16});
  await page.waitForTimeout(250);
  await locator.click();
  await page.waitForTimeout(450);
 };
 const errors=[]; const captures=[]; let changed=false;
 const start=Date.now(); const at=()=> (Date.now()-start)/1000;
 const shot=async label=>{
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');
  await page.screenshot({path:`${output}/${label}.png`});
  captures.push({label,at:at()});
 };
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*.bundle?*',async route=>{
  const response=await route.fetch();
  const original=await response.text();
  const key='e01026772cadd27c05ddbe2384f3c63818e39e87087ad13d526063f80b8c02ca';
  changed ||= original.includes(key);
  await route.fulfill({response,body:original.replaceAll(key,fixture.technicianAuthority)});
 });
 try {
  await page.goto('http://localhost:8081/');
  await tap(page.getByRole('button',{name:'Technician code required. Add it'}));
  await tap(page.getByRole('button',{name:'Paste the code instead'}));
  await page.waitForTimeout(1300);
  await page.getByRole('textbox',{name:'Technician code',exact:true}).fill(fixture.code);
  await page.getByText('✓ Noé',{exact:true}).waitFor();
  await shot('technician');
  await page.waitForTimeout(2200);
  await tap(page.getByRole('button',{name:'Save',exact:true}));
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await tap(page.getByRole('button',{name:'Site Wi-Fi required. Choose a site'}));
  await tap(page.getByRole('textbox',{name:'Site name',exact:true}));
  await page.getByRole('textbox',{name:'Site name',exact:true}).pressSequentially('Demo site · Wing B',{delay:45});
  await tap(page.getByRole('textbox',{name:'Network name',exact:true}));
  await page.getByRole('textbox',{name:'Network name',exact:true}).pressSequentially('Demo-Wing-B',{delay:65});
  await tap(page.getByRole('textbox',{name:'Password',exact:true}));
  await page.getByRole('textbox',{name:'Password',exact:true}).pressSequentially('demo password',{delay:55});
  await shot('wifi');
  await page.waitForTimeout(2200);
  await tap(page.getByRole('button',{name:'Save',exact:true}));
  await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.waitForTimeout(1500);
  const setupEnd=at();
  // Demo mode remounts the application with its own public authority, code and in-memory site.
  await page.goto('http://localhost:8081/?demo=1');
  await page.getByText(/200 in range/).first().waitFor({timeout:85000});
  const batchStart=at();
  await shot('fleet');
  await page.waitForTimeout(1800);
  const row=page.getByRole('button',{name:/^TETON-.*Ready to set up/}).first();
  const sensor=(await row.getAttribute('aria-label')).match(/^TETON-[0-9A-F]{10}/)[0];
  await tap(row);
  await page.waitForTimeout(800);
  await shot('sensor');
  await tap(page.getByRole('button',{name:`Test ${sensor}`,exact:true}));
  await page.getByText('“world” received',{exact:true}).waitFor();
  await shot('test');
  await page.waitForTimeout(2200);
  await tap(page.getByRole('button',{name:`Set up the Wi-Fi of ${sensor}`,exact:true}));
  await page.getByText('Device connected',{exact:true}).waitFor({timeout:30000});
  await shot('manual');
  await page.waitForTimeout(1800);
  await tap(page.getByRole('button',{name:/Set up all ready/}));
  await tap(page.getByRole('tab',{name:/^Not set up,/}));
  await page.getByText(/IN PROGRESS/).first().waitFor();
  await page.waitForTimeout(2500);
  await shot('running');
  await tap(page.getByRole('tab',{name:/^Set up,/}));
  await page.getByRole('button',{name:/Retry failed/}).waitFor({timeout:180000});
  await tap(page.getByRole('tab',{name:/^Errors,/}));
  await page.waitForTimeout(2000);
  await shot('errors');
  await page.waitForTimeout(2000);
  await tap(page.getByRole('button',{name:/Retry failed/}));
  await page.getByRole('button',{name:/Retry failed/}).waitFor({timeout:60000});
  await page.waitForTimeout(1600);
  assert(changed,'public fixture authority must have been installed in this isolated browser');
  assert.deepEqual(errors,[]);
  const metadata={name,width,height,setupEnd,batchStart,end:at(),captures,errors,result:'PASS',scope:'SIMULATION; setup authority replaced only in intercepted browser bundle'};
  const video=page.video();
  await context.close();
  metadata.video=await video.path();
  await writeFile(`${root}${name}-capture.json`,JSON.stringify(metadata,null,2)+'\n');
  console.log(JSON.stringify(metadata));
 } catch(e) { await page.screenshot({path:`/private/tmp/teton-gif-${name}-failure.png`}); await context.close(); throw e; }
}
try { await Promise.all([record('mobile',390,844),record('desktop',1280,800)]); }
finally { await browser.close(); }
