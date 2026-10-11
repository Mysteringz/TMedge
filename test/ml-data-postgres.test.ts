import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { PostgresTrainingDatabase } from '../src/algo/ml-data/database.js';
import { Exports, nativeDump } from '../src/algo/ml-data/exports.js';
import { TrainingDatabaseHealth } from '../src/infrastructure/analytics/training-database-health.js';

test('real PostgreSQL reader bounds previews, rejects writes and multi-statements, and exports restorable SQL through native pg_dump', { skip: !process.env.ML_DATA_TEST_ADMIN_URL }, async () => {
  const admin = new pg.Client({connectionString:process.env.ML_DATA_TEST_ADMIN_URL});await admin.connect();
  const url=new URL(process.env.ML_DATA_TEST_ADMIN_URL ?? '');url.username='crowdaware_reader';url.password='ml-data-test-reader';
  let db:PostgresTrainingDatabase | undefined, exports:Exports | undefined;
  const dir=mkdtempSync(join(tmpdir(),'ml-pg-'));
  try {
    await admin.query("CREATE ROLE crowdaware_reader LOGIN PASSWORD 'ml-data-test-reader' NOSUPERUSER NOCREATEDB NOCREATEROLE");
    await admin.query(readFileSync('deploy/training/schema.sql','utf8'));
    await admin.query('GRANT USAGE ON SCHEMA training TO crowdaware_reader; GRANT SELECT ON ALL TABLES IN SCHEMA training TO crowdaware_reader; GRANT SELECT ON ALL SEQUENCES IN SCHEMA training TO crowdaware_reader');
    await admin.query("INSERT INTO training.frames(id,sensor_uid,modality,reference_at,timestamp_basis,width,height,encoding,payload,payload_sha256,t_min,t_step) VALUES ('test','02:00:00:00:00:01','thermal',now(),'edge_receive',32,24,'thermal_u8',decode(repeat('00',768),'hex'),encode(sha256(decode(repeat('00',768),'hex')),'hex'),20,0.1)");
    db=new PostgresTrainingDatabase(url.toString());
    const health=new TrainingDatabaseHealth({ML_DATABASE_URL:url.toString()});
    try {assert.equal(health.configured,true);assert.equal(await health.available(),true);} finally {await health.close();}
    const schema=await db.schema();assert.ok(schema.some(t=>t.name==='training.frames' && t.columns.some(c=>c.name==='id' && c.primaryKey)));assert.ok(schema.some(t=>t.name==='training.pairs' && t.columns.some(c=>c.references==='training.frames.id')));
    const preview=await db.query('SELECT id, payload, NULL AS empty FROM training.frames');assert.deepEqual(preview.columns,['id','payload','empty']);assert.deepEqual(preview.rows,[['test','[binary: 768 bytes]',null]]);
    assert.equal((await db.query('SELECT n FROM generate_series(1,300) n')).rows.length,200);assert.equal((await db.query('SELECT n FROM generate_series(1,300) n')).truncated,true);
    assert.match(String((await db.query("SELECT repeat('x',10000000) AS huge")).rows[0]?.[0]),/truncated/);
    assert.deepEqual((await db.query('SELECT 1 AS duplicate, 2 AS duplicate')).rows,[['1','2']]);
    for (const sql of ["DELETE FROM training.frames", "WITH deleted AS (DELETE FROM training.frames RETURNING *) SELECT * FROM deleted", 'SELECT 1; COMMIT; SELECT 2', 'COMMIT', 'SET default_transaction_read_only=off', 'COPY training.frames TO STDOUT', "SELECT nextval('training.annotations_id_seq')", "SELECT setval('training.annotations_id_seq',999)"]) await assert.rejects(db.query(sql));
    assert.deepEqual((await db.query('WITH example AS (SELECT 1 AS n) SELECT n FROM example')).rows,[['1']]);
    assert.equal((await admin.query('SELECT count(*) FROM training.frames')).rows[0].count,'1');
    const dump = process.env.ML_DATA_TEST_CONTAINER ? () => spawn('docker',['exec','--env','PGUSER=crowdaware_reader','--env','PGPASSWORD=ml-data-test-reader',process.env.ML_DATA_TEST_CONTAINER ?? '', 'pg_dump','--dbname=crowdaware_training','--no-owner','--no-privileges','--table=training.frames','--table=training.pairs','--table=training.annotations']) : nativeDump(url.toString(),process.env.ML_PG_DUMP || 'pg_dump');
    exports=new Exports(dir,db,dump,10*1024**2,1);const job=exports.start('test','epoch',['training.frames','training.pairs','training.annotations']);
    for (let i=0;i<300 && ['queued','processing'].includes(job.state);i++) await delay(20);
    assert.equal(job.state,'completed',job.error??'');
    const sql=execFileSync('python3',['-c','import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; sys.stdout.buffer.write(z.read("dataset.sql"))',exports.path(job.id)],{maxBuffer:1024*1024});
    assert.match(sql.toString(),/COPY training.frames/);
    // Restoring in a transaction proves SQL correctness without deleting data.
    await admin.query('BEGIN');await admin.query('DROP SCHEMA training CASCADE');
    if (process.env.ML_DATA_TEST_CONTAINER) {
      // pg_dump uses COPY FROM STDIN: a real psql restore in a separate database.
      await admin.query('ROLLBACK');await admin.query('DROP DATABASE IF EXISTS ml_data_restore');await admin.query('CREATE DATABASE ml_data_restore');
      const restore=spawn('docker',['exec','-i',process.env.ML_DATA_TEST_CONTAINER,'psql','-U','postgres','-d','ml_data_restore','-v','ON_ERROR_STOP=1'],{stdio:['pipe','ignore','pipe']});
      let errors='';restore.stderr.on('data',(b:Buffer)=>{errors+=b.toString();});restore.stdin.end(sql);
      const code=await new Promise<number|null>(resolve=>restore.once('close',resolve));assert.equal(code,0,errors);
      const restored=execFileSync('docker',['exec',process.env.ML_DATA_TEST_CONTAINER,'psql','-U','postgres','-d','ml_data_restore','-Atc','SELECT count(*) FROM training.frames'],{encoding:'utf8'});assert.equal(restored.trim(),'1');
      await admin.query('DROP DATABASE ml_data_restore');
    } else { await admin.query('ROLLBACK'); }
  } finally {
    await exports?.stop();await db?.close();await admin.query('ROLLBACK');await admin.query('DROP SCHEMA IF EXISTS training CASCADE');await admin.query('DROP ROLE IF EXISTS crowdaware_reader');await admin.end();rmSync(dir,{recursive:true,force:true});
  }
});
