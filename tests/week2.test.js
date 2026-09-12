// Week 2 feature tests. Harness mirrors tests/week1.test.js: temp DB via DB_PATH, fixture users, app.listen(0).
// Later batches append t.test blocks to this file.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'pulse-week2-'));
process.env.DB_PATH=path.join(dir,'test.db');process.env.NODE_ENV='test';
process.env.ADMIN_EMAIL='test-admin@example.test';process.env.ADMIN_DEFAULT_PASSWORD='FixturePasswordOnly!';
process.env.SESSION_SECRET='fixture-session-only';process.env.ANTHROPIC_API_KEY='fixture';
const db=require('../db/db'), bcrypt=require('bcryptjs');
const pass='FixturePasswordOnly!';
for(const [id,name,cap,opening] of [['a','Centre Alpha',100,0],['b','Centre Beta',100,0]]) db.prepare('INSERT INTO centres(owna_id,name,capacity,opening) VALUES(?,?,?,?)').run(id,name,cap,opening);
for(const role of ['viewer','centre','exec','admin']) db.prepare('INSERT INTO users(email,name,password_hash,role,location_id) VALUES(?,?,?,?,?)').run(role+'@example.test',role,bcrypt.hashSync(pass,4),role,role==='centre'?'a':null);
for(const [ll,id] of [[1,'a'],[2,'b']]) db.prepare('UPDATE centres SET ll_id=? WHERE owna_id=?').run(ll,id); // the projection only covers LineLeader-linked centres
const m=require('../services/metrics'), cal=require('../services/calendar'), snap=require('../services/snapshot');

// ===== Batch A fixtures: bookings either side of the Sydney date the clock is frozen on =====
// Frozen instant 2026-09-11T23:30:00Z is 12 September 09:30 in Sydney — the window in which every
// UTC-derived date in this app used to read a day behind.
const FROZEN='2026-09-11T23:30:00Z', SYD='2026-09-12', UTC_DAY='2026-09-11';
const dm=db.prepare('INSERT INTO daily_metrics(owna_id,metric_date,capacity,booked,attended,absent,casual,fee_total) VALUES(?,?,100,?,?,?,?,?)');
dm.run('a','2026-09-06',15,15,0,0,300); // Sun 6 Sep — the day BEFORE the week ownaWeek must cover
// Mon 7 – Fri 11 Sep: the last fully ended Mon–Fri week in Sydney once "today" is Sat 12 Sep.
for(const d of ['2026-09-07','2026-09-08','2026-09-09','2026-09-10','2026-09-11']) dm.run('a',d,50,45,5,0,1000);
dm.run('a',SYD,20,18,2,0,400);        // today in Sydney, still "yesterday" in UTC — must count as PAST
dm.run('a','2026-09-13',30,30,0,0,600); // tomorrow — must count as FUTURE
dm.run('a','2026-09-20',10,10,0,0,200); // further ahead, so MAX(metric_date) is in the future

// Freeze the clock at a real UTC instant. `new Date()` and `Date.now()` report it; everything else
// (Date.UTC, Date.parse, explicit arguments) behaves normally. Restores even if `fn` throws, and
// awaits `fn` when it returns a promise so route tests can run inside the freeze.
const RealDate=Date;
function freeze(iso,fn){
  const fixed=new RealDate(iso).getTime();
  class FakeDate extends RealDate{
    constructor(...a){ return a.length?new RealDate(...a):new RealDate(fixed); } // eslint-disable-line constructor-super
    static now(){ return fixed; }
  }
  const restore=()=>{ global.Date=RealDate; };
  global.Date=FakeDate;
  let out; try{ out=fn(); }catch(e){ restore(); throw e; }
  if(out&&typeof out.then==='function') return out.then((v)=>{restore();return v;},(e)=>{restore();throw e;});
  restore(); return out;
}

const app=require('../server');
let server,base;
async function login(role){const r=await fetch(base+'/login',{method:'POST',body:new URLSearchParams({email:role+'@example.test',password:pass}),redirect:'manual'});assert.equal(r.status,302);return r.headers.get('set-cookie').split(';')[0];}
async function request(url,cookie){return fetch(base+url,{headers:{cookie},redirect:'manual'});}
async function page(url,cookie){const r=await request(url,cookie);assert.equal(r.status,200,url+' '+r.status);return r.text();}

test('Week 2 batch A — Sydney-aware dates',async(t)=>{
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
 try {
 await t.test('the frozen instant really is the previous day in UTC',()=>{
  // If this ever stops holding, every assertion below is proving nothing.
  assert.equal(new Date(FROZEN).toISOString().slice(0,10),UTC_DAY);
  assert.notEqual(SYD,UTC_DAY);
 });

 await t.test('sydneyDate returns the Sydney calendar date, not the UTC one',()=>{
  assert.equal(cal.sydneyDate(new Date(FROZEN)),SYD);            // 09:30 on the 12th in Sydney
  assert.equal(cal.sydneyDate(new Date('2026-09-12T13:59:59Z')),'2026-09-12'); // 23:59:59 AEST
  assert.equal(cal.sydneyDate(new Date('2026-09-12T14:00:00Z')),'2026-09-13'); // midnight AEST
  // Daylight saving (AEDT, +11): January rolls over an hour earlier in UTC terms.
  assert.equal(cal.sydneyDate(new Date('2026-01-15T12:59:59Z')),'2026-01-15');
  assert.equal(cal.sydneyDate(new Date('2026-01-15T13:00:00Z')),'2026-01-16');
 });

 await t.test('the zone follows the real DST rules, not a fixed +10 or +11 offset',()=>{
  // DST starts 2am on the first Sunday in October (4 Oct 2026 = 16:00Z on 3 Oct).
  assert.equal(cal.sydneyDate(new Date('2026-10-03T13:30:00Z')),'2026-10-03'); // still +10
  assert.equal(cal.sydneyDate(new Date('2026-10-04T13:30:00Z')),'2026-10-05'); // +11: a fixed +10 would say the 4th
  // DST ends 3am on the first Sunday in April (5 Apr 2026 = 16:00Z on 4 Apr): a 25-hour day, so
  // these two instants 24 hours apart fall on the SAME Sydney date.
  assert.equal(cal.sydneyDate(new Date('2026-04-04T13:30:00Z')),'2026-04-05'); // +11
  assert.equal(cal.sydneyDate(new Date('2026-04-05T13:30:00Z')),'2026-04-05'); // +10
 });

 await t.test('addDays / daysAgo / daysAhead step calendar days, never 24-hour blocks',()=>{
  assert.equal(cal.addDays('2026-10-03',1),'2026-10-04');   // the 23-hour day
  assert.equal(cal.addDays('2026-04-04',1),'2026-04-05');   // the 25-hour day
  assert.equal(cal.addDays('2026-12-31',1),'2027-01-01');
  assert.equal(cal.addDays('2026-03-01',-1),'2026-02-28');
  freeze(FROZEN,()=>{
   assert.equal(cal.today(),SYD);
   assert.equal(cal.currentMonth(),'2026-09');
   assert.equal(cal.daysAgo(7),'2026-09-05');
   assert.equal(cal.daysAhead(30),'2026-10-12');
  });
 });

 await t.test('todayStr is the Sydney date, including across a month boundary',()=>{
  freeze(FROZEN,()=>{ assert.equal(m.todayStr(),SYD); });
  // 30 September 23:30 UTC is already 1 October in Sydney — the month rolls over too.
  freeze('2026-09-30T23:30:00Z',()=>{
   assert.equal(m.todayStr(),'2026-10-01');
   assert.equal(cal.currentMonth(),'2026-10');
  });
  // 31 December 23:30 UTC is 1 January in Sydney: the reporting year turns over as well.
  freeze('2026-12-31T23:30:00Z',()=>{
   assert.equal(m.todayStr(),'2027-01-01');
   assert.equal(m.yearRange('cy').label,'CY2027');
  });
 });

 await t.test('the ranges anchored on today start from the Sydney day',()=>{
  freeze(FROZEN,()=>{
   assert.deepEqual(m.forwardRange(30),{from:SYD,to:'2026-10-12'});
   // MAX(metric_date) is 2026-09-20, so the default range clamps to today and looks 6 days back.
   assert.deepEqual(m.defaultRange(),{from:'2026-09-06',to:SYD});
  });
 });

 await t.test("the overview's past/future split falls on the Sydney day",()=>{
  freeze(FROZEN,()=>{
   const r=m.overview('2026-09-07','2026-09-20').find((x)=>x.owna_id==='a');
   // Billed to date = Mon–Fri (5 × 1000) + today's 400. On a UTC "today" the 12 Sep row would have
   // been counted as booked-ahead instead: fee_past 5000 / fee_future 1200.
   assert.equal(r.fee_past,5400);
   assert.equal(r.fee_future,800);
   assert.equal(r.past_booked,270);   // 5 × 50 + 20
   assert.equal(r.future_booked,40);  // 30 + 10
   assert.equal(m.totals([r]).fee_past,5400);
   // Forward occupancy looks strictly past today, so today's row is not in it.
   assert.deepEqual(m.forwardOccupancyByCentre(30).a,{occupancy:20,days:2,booked:40});
  });
 });

 await t.test('the COE run-rate week is the last week that ended before the Sydney day',()=>{
  freeze(FROZEN,()=>{
   // Sydney today is Sat 12 Sep, so the last ended Mon–Fri week is 7–11 Sep. On a UTC today
   // (Fri 11 Sep) the same code stepped back a further week, to 31 Aug – 4 Sep.
   assert.deepEqual(m.coeRunWeek(),{from:'2026-09-07',to:'2026-09-11'});
  });
  assert.deepEqual(m.coeRunWeek('2026-09-11'),{from:'2026-08-31',to:'2026-09-04'});
 });

 await t.test('week starts and roster Mondays are real Mondays on any host',()=>{
  // recentMondays: Sat 12 Sep belongs to the week starting Mon 7 Sep.
  freeze(FROZEN,()=>{ assert.deepEqual(snap.recentMondays(3),['2026-09-07','2026-08-31','2026-08-24']); });
  assert.deepEqual(snap.recentMondays(2,'2026-09-07'),['2026-09-07','2026-08-31']); // a Monday is its own week start
  // weekStart, exercised through the projection's weekly buckets: parsing a date as local time and
  // then slicing an ISO string used to land on the Sunday before, on any host east of Greenwich.
  freeze(FROZEN,()=>{
   const weeks=(m.projection('likely',30).rows.find((r)=>r.owna_id==='a')||{weekly:[]}).weekly.map((w)=>w.week);
   assert.ok(weeks.length,'no forward bookings reached the projection');
   for(const w of weeks) assert.equal(new Date(w+'T00:00:00Z').getUTCDay(),1,w+' is not a Monday');
  });
 });

 await t.test('ownaWeek covers Monday–Sunday, not eight days',()=>{
  // Week ending Sun 13 Sep starts Mon 7 Sep. The old local-parse arithmetic returned 6 Sep and swept
  // the Sunday before into the week, making it eight days long.
  const w=m.ownaWeek('a','2026-09-13');
  assert.equal(w.revenue,6000);   // 5 × 1000 + Sat 400 + Sun 600 — the 6 Sep row's 300 is NOT in it
  assert.equal(w.op_days,5);      // Mon–Fri only
  assert.equal(w.child_days,250);
 });

 await t.test('the overview page itself splits on the Sydney day',async()=>{
  const cookie=await login('exec');
  const html=await freeze(FROZEN,()=>page('/?from=2026-09-07&to=2026-09-20',cookie));
  assert.match(html,/5,400/);     // billed to date includes today
  assert.doesNotMatch(html,/5,000/);
 });

 await t.test('the nightly job pins Australia/Sydney rather than trusting the host clock',()=>{
  const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  assert.match(server,/cron\.schedule\([\s\S]*?timezone:\s*CRON_TZ/, 'cron.schedule must be given an explicit timezone');
  assert.equal(cal.TIME_ZONE,'Australia/Sydney');
  const render=fs.readFileSync(path.join(__dirname,'..','render.yaml'),'utf8');
  assert.match(render,/key: TZ\n\s+value: Australia\/Sydney/);
 });

 await t.test('no service or route computes a date from UTC any more',()=>{
  // The regression guard: `new Date()` / `Date.now()` sliced into a YYYY-MM(-DD) string is the bug.
  const bad=[];
  for(const rel of ['services','routes'])
   for(const f of fs.readdirSync(path.join(__dirname,'..',rel)).filter((f)=>f.endsWith('.js'))){
    const src=fs.readFileSync(path.join(__dirname,'..',rel,f),'utf8');
    src.split('\n').forEach((line,i)=>{
     if(/(new Date\(\)|Date\.now\(\))[\s\S]{0,40}?toISOString\(\)\.slice/.test(line)) bad.push(`${rel}/${f}:${i+1}`);
    });
   }
  assert.deepEqual(bad,[],'these lines still derive a calendar date from UTC: '+bad.join(', '));
 });
 } finally {await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
