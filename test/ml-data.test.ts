import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { DataError, readerUrl, type TrainingDatabase } from '../src/algo/ml-data/database.js';
import { Exports, selectedTables, type ExportJob } from '../src/algo/ml-data/exports.js';
import { DIAGRAM_FILE, schemaAssets, schemaDiagram, schemaHtml } from '../src/algo/ml-data/schema-report.js';
import { createMlData } from '../src/algo/ml-data/routes.js';
import { principal } from '../src/modules/algo-admin/domain/permissions.js';

const tables = [{ name: 'training.frames', kind: 'table' as const, columns: [], estimatedRows: 1, bytes: 500 }, { name: 'training.ml_samples', kind: 'view' as const, columns: [], estimatedRows: null, bytes: null }];
const db: TrainingDatabase = { schema: async () => tables, query: async () => ({ columns: ['id'], rows: [['safe']], truncated: false, elapsedMs: 1 }), close: async () => undefined };
const dump = () => spawn(process.execPath, ['-e', 'process.stdout.write("CREATE TABLE training.frames(id text);\\nCOPY training.frames FROM stdin;\\nsafe\\n\\\\.\\n");']);
async function finished(exports: Exports, job: ExportJob) {
  for (let i=0;i<200;i++) { const state=exports.get(job.id,job.owner,job.epoch); if (!['queued','processing'].includes(state.state)) return state; await delay(10); }
  throw new Error('export did not finish');
}

test('ML data accepts only a private dedicated reader credential and explicit training table names', () => {
  const dir = mkdtempSync(join(tmpdir(),'ml-credentials-'));
  try {
    const url='postgresql://crowdaware_reader:test@127.0.0.1/crowdaware_training';
    assert.equal(readerUrl({}),null); assert.equal(readerUrl({ ML_DATABASE_URL:url }),url);
    for (const value of [url.replace('crowdaware_reader','crowdaware_ingest'),url+'?options=-c%20default_transaction_read_only=off',url.replace('crowdaware_training','student')]) assert.throws(()=>readerUrl({ML_DATABASE_URL:value}));
    const file=join(dir,'reader.url');writeFileSync(file,url,{mode:0o600});assert.equal(readerUrl({ML_DATABASE_URL_FILE:file}),url);
    assert.throws(()=>readerUrl({ML_DATABASE_URL:url,ML_DATABASE_URL_FILE:file}));
    const publicFile=join(dir,'public.url');writeFileSync(publicFile,url,{mode:0o644});assert.throws(()=>readerUrl({ML_DATABASE_URL_FILE:publicFile}));
    for (const value of [[],['public.users'],['training.frames; DROP TABLE training.frames'],['training.*'],['training.frames','training.frames']]) assert.throws(()=>selectedTables(value),DataError);
    assert.deepEqual(selectedTables(['training.frames']),['training.frames']);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('background exports create a real compressed ZIP, persist its hash, isolate owners and expire after 24 hours', async () => {
  const dir=mkdtempSync(join(tmpdir(),'ml-export-'));let exports=new Exports(dir,db,dump,1000000,1);
  try {
    const job=exports.start('ada','epoch',['training.frames']);assert.equal(job.state,'queued');
    assert.throws(()=>exports.start('ada','epoch',['training.frames']),/Another export/);
    assert.throws(()=>exports.get(job.id,'other','epoch'),/not found/);assert.throws(()=>exports.get(job.id,'ada','new-epoch'),/not found/);
    const complete=await finished(exports,job);assert.equal(complete.state,'completed');
    const archive=readFileSync(exports.path(job.id));assert.equal(complete.sha256,createHash('sha256').update(archive).digest('hex'));
    const output=execFileSync('python3',['-c','import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert set(z.namelist()) == {"dataset.sql","manifest.json"}; assert b"COPY training.frames" in z.read("dataset.sql"); print(json.loads(z.read("manifest.json"))["tables"][0])',exports.path(job.id)],{encoding:'utf8'});
    assert.equal(output.trim(),'training.frames');
    await exports.stop();exports=new Exports(dir,db,dump,1000000,1);assert.equal(exports.get(job.id,'ada','epoch').state,'completed');
    const release=exports.lease(job.id), releaseSecond=exports.lease(job.id);
    exports.cleanup(complete.expiresAt+1);assert.equal(existsSync(exports.path(job.id)),true);release();release();
    exports.cleanup(complete.expiresAt+1);assert.equal(existsSync(exports.path(job.id)),true);releaseSecond();
    exports.cleanup(complete.expiresAt+1);assert.equal(existsSync(exports.path(job.id)),false);assert.equal(existsSync(join(dir,job.id+'.json')),false);
  } finally { await exports.stop();rmSync(dir,{recursive:true,force:true}); }
});

test('shutdown during schema lookup never starts a new pg_dump', async () => {
  const dir=mkdtempSync(join(tmpdir(),'ml-export-stop-'));
  let completeSchema: (() => void) | undefined, startedSchema: (() => void) | undefined;
  const started=new Promise<void>(resolve=>{startedSchema=resolve;});
  const slow:TrainingDatabase={...db,schema:()=>new Promise(resolve=>{completeSchema=()=>resolve(tables);startedSchema?.();})};
  let dumps=0;
  const exports=new Exports(dir,slow,()=>{dumps++;return dump();},1000000,1);
  try {
    const job=exports.start('ada','epoch',['training.frames']);await started;
    const stopping=exports.stop();completeSchema?.();await stopping;
    assert.equal(dumps,0);assert.equal(job.state,'failed');assert.equal(existsSync(exports.path(job.id)),false);
  } finally { await exports.stop();rmSync(dir,{recursive:true,force:true}); }
});

test('failed pg_dump, views, disk quota and server restart never publish partial downloads', async () => {
  const dir=mkdtempSync(join(tmpdir(),'ml-export-fail-'));let exports=new Exports(dir,db,()=>spawn(process.execPath,['-e','process.stdout.write("partial"); process.exitCode=1;']),1000000,1);
  try {
    let job=exports.start('ada','epoch',['training.frames']);assert.equal((await finished(exports,job)).state,'failed');assert.equal(existsSync(exports.path(job.id)),false);assert.equal(existsSync(join(dir,job.id+'.part')),false);
    job=exports.start('ada','epoch',['training.ml_samples']);assert.match((await finished(exports,job)).error??'',/table is unavailable/);
    await exports.stop();exports=new Exports(dir,db,dump,10,1);job=exports.start('ada','epoch',['training.frames']);assert.equal((await finished(exports,job)).state,'failed');assert.equal(existsSync(exports.path(job.id)),false);
    await exports.stop();
    const interrupted={...job,id:'12345678-1234-1234-1234-123456789abc',state:'processing',error:null};writeFileSync(join(dir,interrupted.id+'.json'),JSON.stringify(interrupted));writeFileSync(join(dir,interrupted.id+'.part'),'partial');
    exports=new Exports(dir,db,dump,1000000,1);assert.match(exports.get(interrupted.id,'ada','epoch').error??'',/restart/);assert.equal(existsSync(join(dir,interrupted.id+'.part')),false);
  } finally { await exports.stop();rmSync(dir,{recursive:true,force:true}); }
});

test('ML HTTP routes enforce sessions, training capabilities, CSRF, owner epochs, 202 and resumable no-cache downloads', async () => {
  const dir=mkdtempSync(join(tmpdir(),'ml-http-'));
  const exports=new Exports(dir,db,dump,1000000,1);let epoch='epoch';
  const auth={principalOf:(req:{headers:{cookie?:string}})=>req.headers.cookie==='viewer' ? principal('vi','viewer') : req.headers.cookie==='ada' ? principal('ada','operator') : req.headers.cookie==='other' ? principal('other','admin') : null,accountEpoch:()=>epoch};
  const service=createMlData(auth,{env:{},dataDir:dir,db,exports});const app=express();app.use(express.json());app.use('/api/ml-data',service.router);const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ml-data`;
  const headers={'Content-Type':'application/json','x-tm-algo':'1',cookie:'ada'};
  try {
    assert.equal((await fetch(base+'/schema')).status,401);
    assert.equal((await fetch(base+'/schema',{headers:{cookie:'viewer'}})).status,200);
    assert.equal((await fetch(base+'/query',{method:'POST',headers:{'Content-Type':'application/json',cookie:'ada'},body:JSON.stringify({sql:'SELECT 1'})})).status,403);
    assert.equal((await fetch(base+'/query',{method:'POST',headers:{...headers,cookie:'viewer'},body:JSON.stringify({sql:'SELECT 1'})})).status,200);
    assert.equal((await fetch(base+'/exports',{method:'POST',headers:{...headers,cookie:'viewer'},body:JSON.stringify({tables:['training.frames']})})).status,403);
    const response=await fetch(base+'/exports',{method:'POST',headers,body:JSON.stringify({tables:['training.frames']})});assert.equal(response.status,202);const job=await response.json() as ExportJob;
    assert.equal((await fetch(base+`/exports/${job.id}/download`,{headers})).status,409);
    await finished(exports,{...job,owner:'ada',epoch});
    assert.equal((await fetch(base+`/exports/${job.id}`,{headers:{cookie:'other'}})).status,404);
    const download=await fetch(base+`/exports/${job.id}/download`,{headers:{cookie:'ada',Range:'bytes=0-9'}});assert.equal(download.status,206);assert.equal((await download.arrayBuffer()).byteLength,10);assert.match(download.headers.get('cache-control')??'',/no-store/);assert.equal(download.headers.get('cloudflare-cdn-cache-control'),'no-store');
    epoch='replacement';assert.equal((await fetch(base+`/exports/${job.id}`,{headers})).status,404);
  } finally { await service.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true}); }
});

test('ML query responses are withheld if an account changes while the database is answering', async () => {
  const dir=mkdtempSync(join(tmpdir(),'ml-race-'));let epoch='before';
  const auth={principalOf:()=>principal('ada','operator'),accountEpoch:()=>epoch};
  const changed:TrainingDatabase={...db,query:async()=>{epoch='after';return {columns:['secret'],rows:[['private']],truncated:false,elapsedMs:1};}};
  const service=createMlData(auth,{env:{},dataDir:dir,db:changed});const app=express();app.use(express.json());app.use('/api/ml-data',service.router);const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  try { const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ml-data/query`,{method:'POST',headers:{'Content-Type':'application/json','x-tm-algo':'1'},body:JSON.stringify({sql:'SELECT 1'})});assert.equal(response.status,401);assert.equal((await response.text()).includes('private'),false); }
  finally { await service.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true}); }
});


test('SchemaSpy embeds private diagrams and report code while publishing only generic libraries and fonts', async () => {
  const dir=mkdtempSync(join(tmpdir(),'ml-schema-'));
  try {
    mkdirSync(join(dir,'bower'));mkdirSync(join(dir,'fonts'));mkdirSync(join(dir,'diagrams'));
    writeFileSync(join(dir,'bower','vendor.js'),'window.vendor=true;');
    writeFileSync(join(dir,'schema.js'),'window.schema="private-schema-marker";');
    writeFileSync(join(dir,'schema.css'),'body{color:black}');
    writeFileSync(join(dir,'diagrams','relations.png'),Buffer.from([1,2,3]));
    const file=join(dir,'index.html');writeFileSync(file,'<html><body><link rel="stylesheet" href="schema.css"><script src="bower/vendor.js"></script><script src="schema.js"></script><img src="diagrams/relations.png"><a href="relationships.html">Relationships</a></body></html>');
    const rendered=schemaHtml(dir,file);assert.match(rendered,/\/ml-schema-assets\/bower\/vendor.js/);assert.match(rendered,/private-schema-marker/);assert.match(rendered,/data:image\/png;base64,AQID/);assert.match(rendered,/schemaspy-navigate/);assert.match(rendered,/<style>body/);
    const app=express();app.use('/ml-schema-assets',schemaAssets(dir));const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/ml-schema-assets`;
    try { assert.equal((await fetch(base+'/bower/vendor.js')).status,200);assert.equal((await fetch(base+'/index.html')).status,404);assert.equal((await fetch(base+'/diagrams/relations.png')).status,404);assert.equal((await fetch(base+'/schema.js')).status,404); }
    finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('Graphviz diagram metadata and image require training access and revisions refresh when a new report is published', async () => {
  const dir=mkdtempSync(join(tmpdir(),'ml-diagram-'));
  const auth={principalOf:(req:{headers:{cookie?:string}})=>req.headers.cookie==='viewer'?principal('vi','viewer'):null,accountEpoch:()=>null};
  const service=createMlData(auth,{env:{ML_SCHEMA_DIR:dir},dataDir:dir});
  const app=express();app.use('/api/ml-data',service.router);const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ml-data/schema/diagram`,headers={cookie:'viewer'};
  try {
    assert.equal((await fetch(base)).status,401);assert.equal((await fetch(base+'/image')).status,401);
    assert.equal((await(await fetch(base,{headers})).json() as {available:boolean}).available,false);
    assert.equal((await fetch(base+'/image',{headers})).status,404);
    mkdirSync(join(dir,'diagrams','summary'),{recursive:true});
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1EAAAAASUVORK5CYII=','base64');
    writeFileSync(join(dir,DIAGRAM_FILE),png);writeFileSync(join(dir,'generated.json'),JSON.stringify({generatedAt:1000}));
    const first=schemaDiagram(dir);assert.equal(first.available,true);
    const image=await fetch(base+'/image?v=first',{headers});assert.equal(image.status,200);assert.match(image.headers.get('cache-control')??'',/no-store/);assert.equal(image.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
    writeFileSync(join(dir,'generated.json'),JSON.stringify({generatedAt:2000}));assert.notEqual(schemaDiagram(dir).revision,first.revision);
    writeFileSync(join(dir,DIAGRAM_FILE),'bad image');assert.equal(schemaDiagram(dir).available,false);
  } finally {await service.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});
