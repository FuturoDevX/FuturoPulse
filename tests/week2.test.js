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

 // ===== Batch B: the nightly COE snapshot — measured continuing count + booking mix =====
 // Fixtures are inserted here, last, so no earlier batch is affected. The OWNA client is stubbed by
 // replacing the methods on the shared `owna` object (services/snapshot.js destructured the same object
 // at require time, so it sees these): no test ever calls the real API.
 const COE_KIDS={
  // Alpha: one family rolled forward to the end of the window, one that stops at 31 December, one
  // leaving on 20 November (an OWNA local-midnight-in-UTC finish date), one booked only this month.
  a:[['a-child-771','mo,tu,we','2026-09-14','2027-04-30',null],
     ['a-child-772','th,fr','2026-09-14','2026-12-31',null],
     ['a-child-773','mo,tu,we,th,fr','2026-09-14','2026-11-20','2026-11-19T13:00:00Z'],
     ['a-child-774','mo','2026-09-14','2026-09-30',null]],
  // Beta: every family's recurring bookings stop dead on 31 December — the Heath Rd pattern. All three
  // are booked on a Thursday, so all three end on exactly that day.
  b:[['b-child-881','th,fr','2026-09-14','2026-12-31',null],
     ['b-child-882','tu,we,th','2026-09-14','2026-12-31',null],
     ['b-child-883','mo,tu,we,th','2026-09-14','2026-12-31',null]],
 };
 const DOW={mo:1,tu:2,we:3,th:4,fr:5};
 const coeDays=(csv,from,to)=>{const want=new Set(csv.split(',').map(d=>DOW[d]));return cal.operatingDayList(from,to).filter(d=>want.has(new Date(d+'T00:00:00Z').getUTCDay()));};
 const COE_FIX={};
 for(const [id,kids] of Object.entries(COE_KIDS)){
  const children=kids.map(([cid,,,,finish])=>({id:cid,firstname:'Fixture',surname:'Child '+cid,dob:'2022-04-05T14:00:00Z',finishDate:finish,room:'Room 1'}));
  const attendance=[];
  for(const [cid,csv,from,to] of kids)
   for(const d of coeDays(csv,from,to)) attendance.push({attendanceDate:d+'T00:00:00',childId:cid,child:'Fixture Child '+cid,room:'Room 1',attending:true,fee:110});
  // Three rows the step must ignore: a repeat of a booking OWNA already returned, a booking on Christmas
  // Day (OWNA keeps rows on public holidays), and one before today.
  attendance.push({...attendance[0]});
  attendance.push({attendanceDate:'2026-12-25T00:00:00',childId:kids[0][0],child:'Fixture Child',attending:false,fee:0});
  attendance.push({attendanceDate:'2026-09-10T00:00:00',childId:kids[0][0],child:'Fixture Child',attending:true,fee:110});
  COE_FIX[id]={children,attendance};
 }
 const ownaClient=require('../services/owna').owna;
 ownaClient.listChildren=async(id)=>(COE_FIX[id]||{children:[]}).children;
 ownaClient.attendance=async(id,from,to)=>(COE_FIX[id]||{attendance:[]}).attendance.filter(r=>r.attendanceDate.slice(0,10)>=String(from).slice(0,10)&&r.attendanceDate.slice(0,10)<=String(to).slice(0,10));
 const MONTHS=['2026-11','2026-12','2027-01','2027-02','2027-03','2027-04'];
 const OPDAYS={'2026-11':21,'2026-12':21,'2027-01':19,'2027-02':20,'2027-03':21,'2027-04':22};
 const monthEnd=(mo)=>{const [y,m2]=mo.split('-').map(Number);return mo+'-'+new Date(Date.UTC(y,m2,0)).getUTCDate();};
 const contRow=(owna,mo)=>db.prepare('SELECT * FROM coe_continuing WHERE snapshot_date=? AND owna_id=? AND month=?').get(SYD,owna,mo);

 await t.test('the COE page works, and says so, before any snapshot has been taken',async()=>{
  assert.equal(db.prepare('SELECT COUNT(*) n FROM coe_continuing').get().n,0);
  const cookie=await login('viewer');
  const html=await freeze(FROZEN,()=>page('/coe',cookie));
  assert.match(html,/no snapshot of forward bookings has been taken/i);
  assert.match(html,/npm run coe-snapshot/);
  assert.match(html,/measured per-child continuing count starts accumulating/i);
  assert.doesNotMatch(html,/Measured continuing count as at/);   // the badge only appears once it exists
  assert.match(html,/run rate assumes every family without a finish date continues/); // limit 1 still stands
  assert.match(html,/Month by month/);                           // and the run-rate projection is untouched
 });

 await t.test('the nightly step splits the children enrolled now into continuing, not yet confirmed and leaving',async()=>{
  const r=await freeze(FROZEN,()=>snap.runCoeSnapshot());
  assert.equal(r.ok,true);assert.equal(r.snapshot_date,SYD);assert.equal(r.failed,0);assert.equal(r.attempts,2);
  assert.equal(r.rows,12);assert.equal(r.mix_rows,10);assert.equal(r.window_to,'2027-04-30');
  // Alpha, month by month. Nov: the leaver is still booked, so she is continuing; from December she is gone.
  const nov=contRow('a','2026-11');
  assert.equal(nov.enrolled,4);assert.equal(nov.operating_days,21);assert.equal(nov.beyond_horizon,0);
  assert.equal(nov.continuing,3);assert.equal(nov.not_confirmed,1);assert.equal(nov.leaving,0);
  // Booked child-days are counted from the bookings themselves, over operating days only.
  const novDays=coeDays('mo,tu,we','2026-11-01','2026-11-30').length+coeDays('th,fr','2026-11-01','2026-11-30').length+coeDays('mo,tu,we,th,fr','2026-11-01','2026-11-20').length;
  assert.equal(nov.continuing_days,novDays);
  assert.equal(nov.not_confirmed_days,4.2);                    // the one-day family: 1 × 21/5
  assert.equal(nov.leaving_days,0);
  const dec=contRow('a','2026-12');
  assert.equal(dec.continuing,2);assert.equal(dec.not_confirmed,1);assert.equal(dec.leaving,1);
  assert.equal(dec.leaving_days,21);                           // her OWN five days a week × 21/5, not the centre average
  assert.equal(dec.continuing_days,coeDays('mo,tu,we','2026-12-01','2026-12-31').length+coeDays('th,fr','2026-12-01','2026-12-31').length);
  for(const mo of ['2027-01','2027-02','2027-03','2027-04']){
   const x=contRow('a',mo);
   assert.equal(x.continuing,1,mo);                            // only the family rolled forward to April
   assert.equal(x.not_confirmed,2,mo);                         // the 31-December family joins the working list
   assert.equal(x.leaving,1,mo);
   assert.equal(x.not_confirmed_days,Math.round(3*(OPDAYS[mo]/5)*10)/10,mo); // 2 days + 1 day a week
   assert.equal(x.beyond_horizon,0,mo);                        // Alpha's own bookings do reach these months
  }
  assert.deepEqual(MONTHS.map(mo=>contRow('a',mo).continuing_days>0),[true,true,true,true,true,true]);
  // Public holidays, repeated rows and past bookings are all out: Christmas Day adds nothing to December.
  assert.equal(dec.continuing_days,coeDays('mo,tu,we','2026-12-01','2026-12-31').length+coeDays('th,fr','2026-12-01','2026-12-31').length);
 });

 await t.test('a centre whose forward bookings stop dead on one date is reported as that, not as a collapse',()=>{
  const h=db.prepare('SELECT * FROM coe_forward_horizon WHERE snapshot_date=? AND owna_id=?').get(SYD,'b');
  assert.equal(h.last_booking_date,'2026-12-31');
  assert.equal(h.enrolled,3);assert.equal(h.horizon_children,3); // every child stops on the same day
  assert.equal(h.window_to,'2027-04-30');assert.equal(h.week_from,'2026-09-14');assert.equal(h.week_to,'2026-09-18');
  for(const mo of ['2026-11','2026-12']){const x=contRow('b',mo);assert.equal(x.beyond_horizon,0,mo);assert.equal(x.continuing,3,mo);assert.equal(x.leaving,0,mo);}
  for(const mo of ['2027-01','2027-02','2027-03','2027-04']){
   const x=contRow('b',mo);
   assert.equal(x.beyond_horizon,1,mo);
   assert.equal(x.leaving,0,mo);                                // nobody has a finish date: they are NOT leaving
   assert.equal(x.not_confirmed,3,mo);
  }
  // Alpha's own bookings run to April, so it is never marked beyond the horizon.
  const ha=db.prepare('SELECT * FROM coe_forward_horizon WHERE snapshot_date=? AND owna_id=?').get(SYD,'a');
  assert.equal(ha.last_booking_date,'2027-04-28');assert.equal(ha.enrolled,4); // its last family books Mon–Wed
  const ms=freeze(FROZEN,()=>m.coeMeasured());
  const beta=ms.centres.find(c=>c.owna_id==='b'), alpha=ms.centres.find(c=>c.owna_id==='a');
  assert.equal(beta.stops_early,true);assert.equal(beta.stops_together,true);
  assert.equal(alpha.stops_early,false);
  assert.deepEqual(ms.stops.map(c=>c.owna_id),['b']);
  // The group row for a month Beta cannot reach covers Alpha only, and says so.
  const jan=ms.months.find(x=>x.month==='2027-01');
  assert.equal(jan.continuing,1);assert.equal(jan.enrolled,4);assert.equal(jan.centres_measured,1);assert.equal(jan.centres_beyond,1);
  const novG=ms.months.find(x=>x.month==='2026-11');
  assert.equal(novG.centres_beyond,0);assert.equal(novG.continuing,6);assert.equal(novG.enrolled,7);
 });

 await t.test('the booking mix counts children per band and the child-days a week each band represents',()=>{
  const mix=(owna)=>db.prepare('SELECT days_per_week,children,child_days FROM coe_booking_mix WHERE snapshot_date=? AND owna_id=? ORDER BY days_per_week').all(SYD,owna);
  assert.deepEqual(mix('a').map(r=>[r.days_per_week,r.children,r.child_days]),[[1,1,1],[2,1,2],[3,1,3],[4,0,0],[5,1,5]]);
  assert.deepEqual(mix('b').map(r=>[r.days_per_week,r.children,r.child_days]),[[1,0,0],[2,1,2],[3,1,3],[4,1,4],[5,0,0]]);
  const ms=freeze(FROZEN,()=>m.coeMeasured());
  const alpha=ms.centres.find(c=>c.owna_id==='a');
  assert.equal(alpha.mix_children,4);assert.equal(alpha.mix_child_days,11);
  assert.equal(alpha.avg_days_per_child,2.75);
  assert.equal(alpha.places_filled_pct,4);                      // 4 children of 100 licensed places
  assert.equal(alpha.days_filled_pct,2.2);                      // but only 11 of the 500 child-days a week
  assert.equal(ms.group.mix_children,7);assert.equal(ms.group.mix_child_days,20);
  assert.deepEqual(ms.group.mix.map(b=>b.children),[1,2,2,1,1]);
  assert.equal(ms.group.places,200);assert.equal(ms.group.places_filled_pct,3.5);assert.equal(ms.group.days_filled_pct,2);
 });

 await t.test('re-running the same day overwrites that day, and stores no name and no date of birth',async()=>{
  const before=db.prepare('SELECT * FROM coe_continuing ORDER BY owna_id,month').all();
  const mixBefore=db.prepare('SELECT * FROM coe_booking_mix ORDER BY owna_id,days_per_week').all();
  await freeze(FROZEN,()=>snap.runCoeSnapshot());
  await freeze(FROZEN,()=>snap.runCoeSnapshot());
  const after=db.prepare('SELECT * FROM coe_continuing ORDER BY owna_id,month').all();
  assert.equal(after.length,before.length);                     // 3 runs, still 12 rows — keyed by snapshot date
  assert.equal(db.prepare('SELECT COUNT(*) n FROM coe_booking_mix').get().n,mixBefore.length);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM coe_forward_horizon').get().n,2);
  const strip=(rows)=>rows.map(r=>{const {updated_at,...rest}=r;return rest;});
  assert.deepEqual(strip(after),strip(before));                 // and the counts are identical, not doubled
  // Nothing that identifies a child may be in these tables: not a name, not a date of birth, not the
  // OWNA child id that could be rejoined to one — in any column, in any row.
  const dump=JSON.stringify([db.prepare('SELECT * FROM coe_continuing').all(),db.prepare('SELECT * FROM coe_booking_mix').all(),db.prepare('SELECT * FROM coe_forward_horizon').all()]);
  for(const bad of ['Fixture','Child','2022-04-05','a-child-771','b-child-881','dob','firstname','surname'])
   assert.ok(!dump.includes(bad),'the COE tables contain "'+bad+'"');
  for(const table of ['coe_continuing','coe_booking_mix','coe_forward_horizon']){
   const cols=db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name);
   for(const c of cols) assert.ok(!/name|dob|birth|child_id|childid/.test(c),table+'.'+c+' looks like it holds a person');
  }
 });

 await t.test('/coe shows the measured count and the booking mix beside the run rate, to a viewer',async()=>{
  const cookie=await login('viewer');
  const html=await freeze(FROZEN,()=>page('/coe',cookie));
  assert.match(html,/Measured continuing count as at/);
  assert.match(html,/The measured continuing count/);
  assert.match(html,/Booking mix/);
  assert.match(html,/Not yet confirmed/);
  assert.match(html,/Places filled against days filled/);
  assert.doesNotMatch(html,/no snapshot of forward bookings has been taken/i);
  // Limit 1 now carries the measured figures instead of promising them.
  assert.match(html,/the measured count beside it does not/);
  assert.doesNotMatch(html,/continuing count arrives in the next build/);
  // Beta's cliff is named on the page, with the date, instead of reading as three families leaving.
  assert.match(html,/forward bookings stop on 31 Dec 2026/);
  assert.match(html,/3 of its 3 children have their last booking on that one day/);
  // Viewer-safe: counts only. No fixture child's name, id or date of birth reaches the page.
  for(const bad of ['a-child-771','b-child-881','Fixture Child','2022-04-05']) assert.ok(!html.includes(bad),'/coe printed '+bad);
  // The run-rate half of the page is still there, unchanged.
  assert.match(html,/Month by month/);assert.match(html,/The working, group total by month/);
 });

 await t.test('the step is wired into the nightly run and can be taken on demand',()=>{
  const src=fs.readFileSync(path.join(__dirname,'..','services','snapshot.js'),'utf8');
  assert.match(src,/await step\("coe", "COE continuing count", \(\) => runCoeSnapshot/,'the nightly run must record the COE step through step()/recordSync');
  const cli=fs.readFileSync(path.join(__dirname,'..','scripts','coe-snapshot.js'),'utf8');
  assert.match(cli,/runCoeSnapshot/);assert.match(cli,/recordSync\("coe"/);
  assert.match(JSON.parse(fs.readFileSync(path.join(__dirname,'..','package.json'),'utf8')).scripts['coe-snapshot'],/scripts\/coe-snapshot\.js/);
  assert.match(fs.readFileSync(path.join(__dirname,'..','docs','outstanding.md'),'utf8'),/npm run coe-snapshot/);
  // A failure has to be visible on the Wages-style status, like every other sub-step.
  snap.recordSync('coe','error','fixture failure');
  assert.equal(snap.sourceSyncFor('coe').status,'error');
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
