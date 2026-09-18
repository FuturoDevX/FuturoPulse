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

// Freeze the APP's clock at a real UTC instant — not the process's. Every date-level decision in
// this codebase goes through services/calendar.js, so setNow() there is enough to put the app at any
// instant, and the rest of the process keeps real time.
//
// This used to swap the global Date for a subclass. That works for synchronous code, but it also
// stops the clock for Node's fetch, whose keep-alive sockets are aged out on a timer: a test that
// awaited an HTTP request under the frozen clock left a connection that could never time out, so
// server.close() in this file's finally never called back and the process hung for minutes after
// every assertion had passed — the runner eventually giving up with "[error] request failed".
// Restores even if `fn` throws, and awaits `fn` when it returns a promise so route tests can run
// inside the freeze, which is now safe.
function freeze(iso,fn){
  cal.setNow(iso);
  const restore=()=>{ cal.setNow(null); };
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
  // freeze() must move the APP's clock only. An earlier version swapped the global Date, which also
  // stopped the timers Node's fetch ages its keep-alive sockets on, so a frozen request left a
  // connection that never closed and this file hung for minutes after passing. If the global clock
  // is ever frozen again, this catches it here instead of as a mysterious hang at the end.
  const RealDate=Date, before=Date.now();
  freeze(FROZEN,()=>{
   assert.equal(Date,RealDate,'freeze() must not replace the global Date');
   assert.ok(Date.now()>=before,'the real clock must keep running while the app is frozen');
   assert.equal(cal.today(),SYD,'while the app still reads the frozen date');
  });
  assert.equal(cal.today(),cal.sydneyDate(new Date()),'the app clock is back on real time afterwards');
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
 // The real client pulls attendance in monthly chunks and reports whether any chunk came back short, so
 // that a booking horizon is never inferred from an incomplete pull. The fixture is complete by
 // construction: no short chunks.
 ownaClient.attendanceDetailed=async(id,from,to)=>({rows:await ownaClient.attendance(id,from,to),chunks:[],short:[]});
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
  assert.match(html,/measured\s+count of children who actually hold bookings starts from the first nightly run/i);
  assert.doesNotMatch(html,/Measured continuing count as at/);   // the badge only appears once it exists
  assert.match(html,/assumes every family without a finish date stays/); // limit 1 still stands
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
  assert.match(html,/The roll against the week/);
  // Children share a place across the week, so children ÷ places is a ratio above 1, never a
  // percentage of places "filled" — that phrasing read as a licence breach to anyone senior.
  assert.match(html,/children<\/strong> share the [\d,]+ licensed places/);
  assert.match(html,/Children per place/);
  assert.doesNotMatch(html,/places (are )?filled|Places filled|of the [\d,]+ licensed places are held/i);
  assert.doesNotMatch(html,/no snapshot of forward bookings has been taken/i);
  // Limit 1 now carries the measured figures instead of promising them.
  assert.match(html,/hold bookings that reach/,'the measured count leads the page');
  assert.match(html,/projection further down is a ceiling/,'and the projection is named as the ceiling');
  assert.doesNotMatch(html,/continuing count arrives in the next build/);
  // Beta's cliff is named on the page, with the date, instead of reading as three families leaving.
  assert.match(html,/forward bookings stop on 31 Dec 2026/);
  assert.match(html,/3 of its 3 children have their last booking in that final week/);
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

 // ===== Batch C: a session store that survives a restart =====
 // express-session's MemoryStore signed every user out on every deploy and grew without bound. Sessions
 // are now rows in this same SQLite file (middleware/session.js), so what follows is about a login
 // outliving the process that minted it — without outliving its expiry, a password reset or a deletion.
 const ROOT=path.join(__dirname,'..');
 const {spawnSync}=require('child_process');
 const sessionMod=require('../middleware/session'), authMod=require('../middleware/auth');
 db.prepare('INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,?)').run('restart@example.test','Restart Fixture',bcrypt.hashSync(pass,4),'ops_manager');
 db.prepare('INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,?)').run('deleted@example.test','Deleted Fixture',bcrypt.hashSync(pass,4),'exec');
 const loginAs=async(email,at)=>{const r=await fetch((at||base)+'/login',{method:'POST',body:new URLSearchParams({email,password:pass}),redirect:'manual'});assert.equal(r.status,302);return r.headers.get('set-cookie');};
 const cookieOf=(setCookie)=>setCookie.split(';')[0];
 const sidOf=(setCookie)=>{const v=cookieOf(setCookie);return decodeURIComponent(v.slice(v.indexOf('=')+1)).slice(2).split('.')[0];}; // "s:<sid>.<signature>"
 const get=(at,url,cookie)=>fetch(at+url,{headers:{cookie},redirect:'manual'});
 const rows=(sid)=>db.prepare('SELECT COUNT(*) n FROM sessions WHERE sid=?').get(sid).n;
 // Rebuild the app from disk the way a restart does: every file of this project is dropped from the
 // require cache, so server.js, db/db.js and the session store are all constructed afresh against the
 // same DB_PATH. restore() puts the original modules back, so the tests keep the app they started with.
 function restartApp(){
  const inProject=(k)=>k.startsWith(ROOT+path.sep)&&!k.includes(path.sep+'node_modules'+path.sep)&&k!==__filename;
  const saved=new Map();
  for(const k of Object.keys(require.cache)) if(inProject(k)){saved.set(k,require.cache[k]);delete require.cache[k];}
  const fresh={app:require('../server'),db:require('../db/db'),store:require('../middleware/session').store};
  fresh.restore=()=>{
   for(const k of Object.keys(require.cache)) if(inProject(k)&&!saved.has(k)) delete require.cache[k];
   for(const [k,v] of saved) require.cache[k]=v;
  };
  return fresh;
 }

 await t.test('a login is a row in the database, and that row is not a password',async()=>{
  const sc=await loginAs('restart@example.test'), sid=sidOf(sc);
  // The cookie keeps every property it had before the store went in, and carries the expiry.
  assert.match(sc,/HttpOnly/i);assert.match(sc,/SameSite=Lax/i);assert.doesNotMatch(sc,/Secure/i); // not production here
  assert.equal(sessionMod.MAX_AGE_MS,1000*60*60*8);
  const cookieMs=new Date(sc.match(/Expires=([^;]+)/)[1]).getTime()-Date.now();
  assert.ok(cookieMs>1000*60*60*7.5&&cookieMs<=1000*60*60*8,'the cookie should expire about eight hours out, was '+cookieMs+'ms');
  const row=db.prepare('SELECT sess,expire FROM sessions WHERE sid=?').get(sid);
  assert.ok(row,'the login belongs in SQLite, not in the process');
  const sess=JSON.parse(row.sess);
  assert.equal(sess.user.email,'restart@example.test');assert.equal(sess.user.role,'ops_manager');
  // The recheck token is a digest of the password hash, so the verifier itself never reaches a second table.
  assert.doesNotMatch(row.sess,/\$2[aby]\$/,'no bcrypt hash may be written into the sessions table');
  assert.equal(sess.authVersion,authMod.authVersion(db.prepare('SELECT password_hash h FROM users WHERE email=?').get('restart@example.test').h));
  // Every row has an expiry, which is what stops the table growing for ever.
  const ms=new Date(row.expire).getTime()-Date.now();
  assert.ok(ms>1000*60*60*7.5&&ms<=1000*60*60*8,'expire should be about eight hours out, was '+ms+'ms');
  // The eight hours run from the LAST request, not from login: wind the row back and watch a request push it out again.
  db.prepare('UPDATE sessions SET expire=? WHERE sid=?').run(new Date(Date.now()+1000*60*60).toISOString(),sid);
  await new Promise(r=>setTimeout(r,1100)); // Expires has one-second resolution, so let a second actually pass
  const r2=await get(base,'/',cookieOf(sc));
  assert.equal(r2.status,200);
  const pushed=new Date(db.prepare('SELECT expire FROM sessions WHERE sid=?').get(sid).expire).getTime()-Date.now();
  assert.ok(pushed>1000*60*60*7.5,'a request should push the expiry back out to eight hours, was '+pushed+'ms');
  // Pushing the ROW out is only half of it: without `rolling`, the browser keeps the cookie it was
  // given at login and drops it eight hours after login, mid-shift, while the row lingers on disk.
  const sc2=r2.headers.get('set-cookie');
  assert.ok(sc2,'every response must re-send the cookie, or the expiry the browser holds never moves');
  assert.equal(sidOf(sc2),sid,'the refreshed cookie is the same session, not a new one');
  assert.match(sc2,/HttpOnly/i);assert.match(sc2,/SameSite=Lax/i);
  const before=new Date(sc.match(/Expires=([^;]+)/)[1]).getTime(), after=new Date(sc2.match(/Expires=([^;]+)/)[1]).getTime();
  assert.ok(after>before,'the re-sent cookie must expire later than the login one, was '+(after-before)+'ms later');
  assert.ok(after-Date.now()>1000*60*60*7.5,'and about eight hours out from this request, was '+(after-Date.now())+'ms');
 });

 await t.test('a logged-in session survives a restart, and an invalidated one is still refused after one',async()=>{
  const keep=cookieOf(await loginAs('restart@example.test'));
  const doomedSc=await loginAs('deleted@example.test'), doomed=cookieOf(doomedSc), doomedSid=sidOf(doomedSc);
  assert.equal((await get(base,'/',keep)).status,200);
  const fresh=restartApp();
  const s2=fresh.app.listen(0,'127.0.0.1');await new Promise(r=>s2.once('listening',r));
  const b2='http://127.0.0.1:'+s2.address().port;
  try{
   assert.notEqual(fresh.db,db,'the restart opens its own connection to the same file');
   assert.notEqual(fresh.store,sessionMod.store,'and builds its own store');
   // The cookie was minted by a process that, as far as this instance is concerned, is gone.
   const r1=await get(b2,'/',keep);
   assert.equal(r1.status,200,'the session did not survive the restart');
   assert.match(await r1.text(),/badge role-ops_manager/,'and it is still the same login');
   // A cookie for a session that was never stored is not a login.
   assert.equal((await get(b2,'/','connect.sid=s%3Anot-a-real-session.signature')).status,302);
   // The authVersion recheck has to keep biting now that the session outlives the process.
   db.prepare('UPDATE users SET password_hash=? WHERE email=?').run(bcrypt.hashSync('AnotherFixturePassword!',4),'restart@example.test');
   assert.equal((await get(b2,'/',keep)).status,302,'a password reset must invalidate a session that survived a restart');
   assert.equal((await get(b2,'/',doomed)).status,200);
   db.prepare('DELETE FROM users WHERE email=?').run('deleted@example.test');
   assert.equal((await get(b2,'/',doomed)).status,302,'a deleted account must invalidate its surviving session');
   assert.equal(rows(doomedSid),0,'an invalidated session is destroyed, not merely refused');
  } finally { fresh.store.stopPruning();await new Promise(r=>s2.close(r));fresh.db.close();fresh.restore(); }
 });

 await t.test('an expired session is refused, and the store sweeps it off disk',async()=>{
  const sc=await loginAs('exec@example.test'), c=cookieOf(sc), sid=sidOf(sc);
  assert.equal((await get(base,'/',c)).status,200);
  db.prepare('UPDATE sessions SET expire=? WHERE sid=?').run(new Date(Date.now()-60*1000).toISOString(),sid);
  assert.equal((await get(base,'/',c)).status,302,'an expired session is not a login');
  assert.equal(rows(sid),1,'refused on read, but still on disk until the sweep');
  sessionMod.store.clearExpiredSessions();
  assert.equal(rows(sid),0,'expired rows must be pruned, or the table grows for ever');
  const live=cookieOf(await loginAs('exec@example.test'));
  sessionMod.store.clearExpiredSessions();
  assert.equal((await get(base,'/',live)).status,200,'the sweep must leave live sessions alone');
  // The sweep runs on its own, on a timer that must not hold a process open (see the spawn below).
  assert.equal(sessionMod.PRUNE_INTERVAL_MS,1000*60*15);
  assert.ok(sessionMod.store.pruneTimer,'the store should be sweeping on a timer');
  assert.equal(sessionMod.store.pruneTimer.hasRef(),false,"the prune timer must be unref'd");
 });

 await t.test('logging out deletes the row, and the production start-up guards are unchanged',async()=>{
  const sc=await loginAs('exec@example.test'), c=cookieOf(sc), sid=sidOf(sc);
  assert.equal(rows(sid),1);
  const out=await fetch(base+'/logout',{method:'POST',headers:{cookie:c,'content-type':'application/x-www-form-urlencoded'},body:'',redirect:'manual'});
  assert.equal(out.status,302);
  assert.equal(rows(sid),0,'logging out must delete the stored session');
  assert.equal((await get(base,'/',c)).status,302);
  // The cookie is only marked secure in production, and the placeholder-secret guard still refuses to start.
  assert.match(fs.readFileSync(path.join(ROOT,'server.js'),'utf8'),/sessionMiddleware\(\{ secure: isProd \}\)/);
  const env={...process.env,NODE_ENV:'production',DB_PATH:':memory:'};
  const boot=(secret)=>spawnSync(process.execPath,['-e',"require('./server')"],{cwd:ROOT,env:{...env,SESSION_SECRET:secret},encoding:'utf8',timeout:30000});
  const bad=boot('change-me');
  assert.equal(bad.status,1);assert.match(bad.stderr,/SESSION_SECRET/);
  // A real secret boots — and the process still exits, which is the proof that the prune timer is unref'd.
  const good=boot('a-real-production-secret-value');
  assert.equal(good.signal,null,'requiring the app in production must not hang');
  assert.equal(good.status,0,good.stderr);
 });

 // ===== Batch D: the "data as at" stamp is read in Sydney too =====
 // snapshot_runs.started_at/finished_at are SQLite datetime('now') — UTC, stored space-separated.
 // V8 parses that form as LOCAL time, so `new Date(finished_at).toLocaleString('en-AU')` showed a
 // nightly 02:15 Sydney run as 4:15pm the PREVIOUS day: ten hours and a whole calendar day early, on
 // the one date a reader checks to decide whether the numbers are current.
 const SYD_STAMP=(s)=>cal.sydneyStamp(s).replace('Sept','Sep'); // ICU writes Sept or Sep by version
 await t.test('a UTC snapshot timestamp is shown as its Sydney time, on any host',()=>{
  assert.equal(SYD_STAMP('2026-09-11 16:15:00'),'12 Sep, 2:15 am','a 02:15 Sydney run must not read as the previous afternoon');
  assert.equal(SYD_STAMP('2026-09-12 16:20:31'),'13 Sep, 2:20 am');
  assert.equal(SYD_STAMP('2026-09-10 09:47:14'),'10 Sep, 7:47 pm','a daytime run is 10h out without a day shift');
  assert.equal(SYD_STAMP('2026-01-05 13:00:00'),'6 Jan, 12:00 am','daylight saving is +11, not +10');
  assert.equal(cal.sydneyStamp(null),'');assert.equal(cal.sydneyStamp(undefined),'');
  assert.equal(cal.sydneyStamp('not a date'),'not a date','an unparseable value is passed through, never NaN');
  // The zone is pinned in the helper, so dropping TZ from render.yaml cannot shift what is displayed.
  const read=(tz)=>spawnSync(process.execPath,['-e',"process.stdout.write(require('./services/calendar').sydneyStamp('2026-09-11 16:15:00'))"],
    {cwd:ROOT,env:{...process.env,TZ:tz},encoding:'utf8',timeout:30000});
  for(const tz of ['UTC','America/New_York','Asia/Kolkata','Australia/Sydney']){
   const r=read(tz);assert.equal(r.status,0,r.stderr);
   assert.equal(r.stdout.replace('Sept','Sep'),'12 Sep, 2:15 am',`TZ=${tz} must not change the displayed stamp`);
  }
 });

 await t.test('every page footer renders that stamp, never the raw UTC column',async()=>{
  db.prepare("INSERT INTO snapshot_runs(started_at,finished_at,status,rows_written) VALUES('2026-09-12 16:18:02','2026-09-12 16:20:31','ok',10)").run();
  const cookie=await login('exec');
  for(const url of ['/','/coe']){ // the two footers this fixture DB has the data to render
   // NOT under freeze(): these footers format a STORED timestamp, so they do not depend on "now",
   // and freeze() swaps the global Date for the duration of its callback. Awaiting a real HTTP
   // round-trip inside it leaves Node's fetch keeping its socket alive against a clock that never
   // advances, so the connection never times out and server.close() at the end of this file never
   // returns — the tests all pass and the process then hangs. Freeze only synchronous work.
   const html=await page(url,cookie);
   assert.match(html,/Data as at/,url+' should carry a freshness stamp');
   assert.ok(html.includes('13 Sep, 2:20 am')||html.includes('13 Sept, 2:20 am'),url+' must show the Sydney time of the run');
   assert.doesNotMatch(html,/2026-09-12 16:20:31/,url+' must not print the raw UTC column');
   assert.doesNotMatch(html,/12\/09\/2026, 4:20:31/,url+' must not read the stored stamp as host-local time');
  }
  // Rostering and Safety hide their footnote until they have data, so check their source instead.
  for(const f of ['rostering.ejs','safety.ejs'])
   assert.match(fs.readFileSync(path.join(ROOT,'views',f),'utf8'),/sydneyStamp\(lastRun\.finished_at\)/,f+' must render the stamp through sydneyStamp');
  // No view may format a sync timestamp itself again: parsing one by hand, or printing the column
  // raw, is what put these footers a day behind. They all go through sydneyStamp() now.
  const bad=[];
  for(const rel of ['views','views/partials'])
   for(const f of fs.readdirSync(path.join(ROOT,rel)).filter((f)=>f.endsWith('.ejs'))){
    fs.readFileSync(path.join(ROOT,rel,f),'utf8').split('\n').forEach((line,i)=>{
     const stamps=/lastRun\.(finished_at|started_at)|last_success|last_attempt/;
     if(!stamps.test(line)) return;
     if(/new Date\(/.test(line)) bad.push(`${rel}/${f}:${i+1} parses the timestamp itself`);
     else if(/<%[=-]\s*(lastRun\.(finished|started)_at|ps\.last_(success|attempt))/.test(line)) bad.push(`${rel}/${f}:${i+1} prints the raw UTC column`);
    });
   }
  assert.deepEqual(bad,[],'these views must render sync timestamps through sydneyStamp(): '+bad.join(', '));
 });

 // ===== Batch E: a roll that stops INSIDE a campaign month =====
 // Heath Rd's forward bookings stop on 2 April 2027 — one day into the LAST campaign month. Detection
 // asked only "does the roll leave a whole campaign month empty?", which 2 April does not, so April read
 // as a hard continuing count for that centre, was folded into the group row as fully measured, and drew
 // no note at all: the false collapse this section exists to prevent, in the campaign's key month.
 await t.test('a roll that stops part-way INTO a campaign month is reported, not read as a collapse',async()=>{
  db.prepare('INSERT INTO centres(owna_id,name,capacity,opening) VALUES(?,?,?,0)').run('c','Centre Gamma',100);
  db.prepare('INSERT INTO centres(owna_id,name,capacity,opening) VALUES(?,?,?,0)').run('d','Centre Delta',100);
  // Gamma is Heath Rd: ten children on mixed Mon–Fri patterns, every one rolled only as far as Fri 2 Apr
  // 2027. Only four are BOOKED on that Friday — the rest last appear on the Wednesday or Thursday, and
  // the Monday-only child a week earlier, because Easter Monday 29 March is a public holiday.
  const GAMMA=[['c-1','fr'],['c-2','fr'],['c-3','th'],['c-4','th'],['c-5','tu,we'],['c-6','tu,we'],
               ['c-7','mo,tu,we,th,fr'],['c-8','mo,tu,we,th,fr'],['c-9','we'],['c-10','mo']];
  // Delta is the case that must NOT trip it: the whole centre stops together two operating days short of
  // the window's last date, which is what every centre's own pattern does at the edge of the pull.
  const DELTA=[['d-1','mo,tu,we'],['d-2','mo,tu,we'],['d-3','mo,tu,we']];
  const coeFixture=(kids,to)=>({
   children:kids.map(([cid])=>({id:cid,firstname:'Fixture',surname:'Child '+cid,dob:'2022-04-05T14:00:00Z',finishDate:null,room:'Room 1'})),
   attendance:kids.flatMap(([cid,csv])=>coeDays(csv,'2026-09-14',to).map(d=>({attendanceDate:d+'T00:00:00',childId:cid,child:'Fixture Child '+cid,room:'Room 1',attending:true,fee:110}))),
  });
  COE_FIX.c=coeFixture(GAMMA,'2027-04-02');
  COE_FIX.d=coeFixture(DELTA,'2027-04-28');
  const r=await freeze(FROZEN,()=>snap.runCoeSnapshot());
  assert.equal(r.ok,true);assert.equal(r.failed,0);assert.equal(r.attempts,4);assert.equal(r.rows,24);

  const hg=db.prepare('SELECT * FROM coe_forward_horizon WHERE snapshot_date=? AND owna_id=?').get(SYD,'c');
  assert.equal(hg.last_booking_date,'2027-04-02');assert.equal(hg.enrolled,10);
  // The cohort that stops with the roll is the whole Mon–Fri week it ends in. Counting only the children
  // booked on the last day itself found four of ten, so a mid-week cliff read as a trickle, not a stop.
  assert.equal(GAMMA.filter(([,csv])=>csv.split(',').includes('fr')).length,4);
  assert.equal(hg.horizon_children,9);
  for(const mo of ['2026-11','2026-12','2027-01','2027-02','2027-03']){
   const x=contRow('c',mo);
   assert.equal(x.beyond_horizon,0,mo);assert.equal(x.continuing,10,mo); // the roll does cover these in full
  }
  const apr=contRow('c','2027-04');
  // The protection moved on 18 September 2026 and its guarantee did not. beyond_horizon now means only
  // "the pull reached NONE of this month" — a fact, not a heuristic — and April is not that: it holds
  // Thu 1 and Fri 2. What keeps it out of the group is covered_days: two operating days is under a full
  // week, so a child booked one day a week need not appear at all, and the month is marked unquotable.
  assert.equal(apr.beyond_horizon,0,'April is partly covered, so it is not "reached none of"');
  assert.equal(apr.covered_days,2,'1 and 2 April are the operating days the roll reaches');
  assert.equal(apr.leaving,0);                                   // nobody has a finish date: they are NOT leaving
  assert.ok(apr.continuing_days>0,'April does hold that one day of bookings…');
  assert.equal(apr.continuing,6);                                // …and at face value it reads as four of ten gone
  // March IS fully covered and must stay a published figure — this is the case that was being hidden.
  assert.equal(contRow('c','2027-03').covered_days,contRow('c','2027-03').operating_days);

  // Delta stops together too, but only two operating days short of 30 April, so it stays fully measured.
  const hd=db.prepare('SELECT * FROM coe_forward_horizon WHERE snapshot_date=? AND owna_id=?').get(SYD,'d');
  assert.equal(hd.last_booking_date,'2027-04-28');assert.equal(hd.enrolled,3);assert.equal(hd.horizon_children,3);
  for(const mo of MONTHS) assert.equal(contRow('d',mo).beyond_horizon,0,mo);
  assert.equal(contRow('d','2027-04').continuing,3);

  const ms=freeze(FROZEN,()=>m.coeMeasured());
  const gamma=ms.centres.find(x=>x.owna_id==='c'), delta=ms.centres.find(x=>x.owna_id==='d');
  const gApr=gamma.months.find(x=>x.month==='2027-04');
  assert.equal(gApr.thin,true,'two covered days is under a week');
  assert.equal(gApr.in_group,false,'…so it is not in the group figure');
  assert.equal(gApr.partial_horizon,true);
  assert.equal(gamma.stops_early,true);assert.equal(gamma.stops_together,true);
  assert.equal(delta.stops_early,false);
  assert.deepEqual(ms.stops.map(x=>x.owna_id).sort(),['b','c']);
  assert.deepEqual(r.stops.map(x=>x.owna_id).sort(),['b','c']);  // and the run itself reports both
  // Gamma is out of April's group row rather than dragging six of its ten children into it.
  const aprG=ms.months.find(x=>x.month==='2027-04');
  assert.equal(aprG.centres_measured,2);assert.equal(aprG.centres_beyond,2);
  assert.equal(aprG.enrolled,7);assert.equal(aprG.continuing,4);  // Alpha's 1 of 4 and Delta's 3 of 3 only

  const cookie=await login('viewer');
  const html=await freeze(FROZEN,()=>page('/coe',cookie));
  assert.match(html,/Gamma: its forward bookings stop on 2 Apr 2027/);
  assert.match(html,/9 of its 10 children have their last booking in that final week/);
  assert.match(html,/This centre has no bookings after 2 Apr 2027/,'April must render as “—”, not as a count');
  assert.doesNotMatch(html,/Delta: its forward bookings stop/,'two days short of the window is not a cliff');
  for(const bad of ['Fixture Child','2022-04-05']) assert.ok(!html.includes(bad),'/coe printed '+bad);
 });

 // ===== Batch F: a snapshot night that reached only SOME of the centres =====
 // runCoeSnapshot commits per centre and carries on past a failure (and past a centre OWNA returns no
 // children for), so a night that failed for three of four centres still writes rows for the fourth, and
 // step() only raises a problem when every centre fails. coeMeasured() then took MAX(snapshot_date) and
 // read that night alone: /coe silently became a quarter of the group — the headline continuing count,
 // the licensed places, the booking mix — with the previous complete night still sitting in the table and
 // not one caveat on the page. These assertions mutate the COE tables, so this batch runs last.
 await t.test('a partial night does not replace the last complete one, and a partial page says so',async()=>{
  const NIGHT2='2026-09-13';
  const before=freeze(FROZEN,()=>m.coeMeasured());
  assert.equal(before.snapshot_date,SYD);assert.equal(before.centres.length,4);assert.equal(before.group.places,400);
  // Night 2: OWNA refuses the pull for Beta, Gamma and Delta, so only Alpha's rows are written.
  for(const table of ['coe_continuing','coe_booking_mix','coe_forward_horizon']){
   const rows=db.prepare('SELECT * FROM '+table+" WHERE snapshot_date=? AND owna_id='a'").all(SYD);
   assert.ok(rows.length,table+' has no Alpha rows to copy');
   const cols=Object.keys(rows[0]);
   const ins=db.prepare('INSERT INTO '+table+' ('+cols.join(',')+') VALUES ('+cols.map(()=>'?').join(',')+')');
   for(const r of rows) ins.run(cols.map(c=>c==='snapshot_date'?NIGHT2:r[c]));
  }
  assert.equal(db.prepare('SELECT MAX(snapshot_date) d FROM coe_continuing').get().d,NIGHT2);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT owna_id) n FROM coe_continuing WHERE snapshot_date=?').get(NIGHT2).n,1);

  // The page stays on the last night that covered every centre, unchanged, rather than following the
  // newest snapshot_date down to one centre.
  const after=freeze(FROZEN,()=>m.coeMeasured());
  assert.equal(after.snapshot_date,SYD,'a 1-of-4 night must not replace the complete one');
  assert.equal(after.partial,false);assert.equal(after.centres_expected,4);assert.equal(after.centres.length,4);
  assert.deepEqual(after.centres_missing,[]);
  assert.equal(after.group.places,400);assert.equal(after.group.mix_children,before.group.mix_children);
  assert.deepEqual(after.months,before.months,'every measured month must be identical to the complete night');
  const cookie=await login('viewer');
  let html=await freeze(FROZEN,()=>page('/coe',cookie));
  assert.match(html,/Measured continuing count as at 12 Sept? 2026/,'the badge must carry the complete night');
  assert.match(html,/All measured centres/);
  assert.doesNotMatch(html,/centres measured/,'nothing is partial while a complete night is available');

  // Now no night covers every centre: Delta's rows are gone from the complete night too, so the newest
  // partial one is all there is. It may still be shown — but never as the group.
  db.prepare("DELETE FROM coe_continuing WHERE snapshot_date=? AND owna_id='d'").run(SYD);
  const part=freeze(FROZEN,()=>m.coeMeasured());
  assert.equal(part.snapshot_date,NIGHT2);
  assert.equal(part.partial,true);assert.equal(part.centres_expected,4);assert.equal(part.centres.length,1);
  // Ordered by centre name, as the page lists them: Beta, Delta, Gamma.
  assert.deepEqual(part.centres_missing.map(c=>[c.owna_id,c.last_measured]),[['b',SYD],['d',null],['c',SYD]]);
  assert.equal(part.group.places,100);                           // a quarter of the group's licensed places…
  const feb=part.months.find(x=>x.month==='2027-02');
  assert.equal(feb.centres_measured,1);assert.equal(feb.enrolled,4); // …and a quarter of the children

  html=await freeze(FROZEN,()=>page('/coe',cookie));
  assert.match(html,/Measured continuing count as at 13 Sept? 2026 · 1 of 4 centres measured/);
  assert.match(html,/These counts cover 1 of 4 centres measured/,'a partial night must not state a quarter of the group as fact');
  assert.match(html,/not the same group of children/,'and must say the two halves of the page disagree');
  assert.doesNotMatch(html,/All measured centres/,'the group row must name its coverage instead');
  assert.match(html,/did not reach every centre/);
  assert.match(html,/Beta last measured 12 Sept? 2026/);
  assert.match(html,/Gamma last measured 12 Sept? 2026/);
  assert.match(html,/Delta never measured/);
  assert.ok((html.match(/1 of 4 centres measured/g)||[]).length>=4,'the coverage must be stated wherever the measured figures are printed');
  assert.match(html,/Month by month/);                           // the run-rate half is untouched
  for(const bad of ['Fixture Child','2022-04-05']) assert.ok(!html.includes(bad),'/coe printed '+bad);
 });

 // ===== Batch G: approved places — the licensed count, as its own field =====
 // `centres.capacity` is the SUM OF OWNA ROOM CAPACITIES, rewritten by the nightly snapshot. It is not the
 // licensed count: the approved places on the service approval (ACECQA National Register) are, and for
 // Austral the two differ (124 licensed, 122 rooms). Every denominator on the dashboard used the room sum,
 // so utilisation, unused places, seats, the COE available child-days and the booking mix were all judged
 // against a number the regulator never issued, and the group read 499 places instead of 501.
 await t.test('every licensed-places denominator divides by approved places, not the OWNA room sum',()=>{
  // The helper: the approved count wins, the room sum is only a fallback, and "neither" is null — never 0,
  // because a percentage of zero places is a fabricated figure.
  assert.equal(m.placesFor({capacity:100,approved_places:110}),110);
  assert.equal(m.placesFor({capacity:100,approved_places:null}),100);
  assert.equal(m.placesFor({capacity:0,approved_places:null}),null);
  assert.equal(m.placesFor({capacity:0,approved_places:0}),null);
  assert.equal(m.placesFor(null),null);

  const before=freeze(FROZEN,()=>m.utilisationYtd('fy'));
  db.prepare('UPDATE centres SET approved_places=110 WHERE owna_id=?').run('a'); // licensed for 110, rooms add to 100
  try{
   assert.equal(m.placesOf('a'),110);
   assert.equal(m.placesOf('b'),100);   // nothing recorded → the room sum still stands in

   // Overview: the Places column and the occupancy denominator both move to 110.
   const row=freeze(FROZEN,()=>m.overview('2026-09-07','2026-09-11').find(r=>r.owna_id==='a'));
   assert.equal(row.capacity,100);assert.equal(row.places,110);assert.equal(row.op_days,5);assert.equal(row.op_booked,250);
   assert.equal(row.occupancy,m.pct(250,110*5));                 // 45.5%
   assert.notEqual(row.occupancy,m.pct(250,100*5));              // not the 50% the room sum gave
   const tot=m.totals([row]);
   assert.equal(tot.places,110);assert.equal(tot.capacity,100);  // both are reported; the ratio uses places
   assert.equal(tot.op_places_days,550);assert.equal(tot.op_capacity_days,500);
   assert.equal(tot.occupancy,m.pct(250,550));

   // Seats, utilisation (incl. the annual denominator), the day series and the monthly trend.
   const seats=m.seatsFilled('2026-09-07','2026-09-11');
   assert.equal(seats.byOwna.a.places,110);assert.equal(seats.byOwna.a.capacity,100);
   const u=freeze(FROZEN,()=>m.utilisationYtd('fy'));
   const ua=u.rows.find(r=>r.owna_id==='a');
   assert.equal(ua.places,110);
   assert.equal(ua.cap_days,110*u.operating_days_ytd);
   assert.equal(ua.annual_child_days,110*u.operating_days_year);
   assert.equal(u.places,before.places+10);                      // the group total moves with it
   assert.equal(u.group.capacity,u.places);
   assert.equal(u.annual_child_days,u.places*u.operating_days_year);
   assert.equal(m.centreDaily('a','2026-09-07','2026-09-07')[0].occupancy,m.pct(50,110));
   const sep=freeze(FROZEN,()=>m.occupancyTrend('a',24)).find(x=>x.month==='2026-09');
   const sepBooked=db.prepare("SELECT COALESCE(SUM(booked),0) b FROM daily_metrics WHERE owna_id='a' AND substr(metric_date,1,7)='2026-09' AND metric_date<=?").get(SYD).b;
   assert.equal(sep.occupancy,m.pct(sepBooked,110*sep.days));

   // Unused places / utilisation by month, and the Compare page that draws them.
   const pm=m.placesByMonth('a',m.placesOf('a'),'2026-09','2026-09')[0];
   assert.equal(pm.places,110);
   assert.equal(pm.unused_places,Math.round((110-pm.avg_booked)*10)/10);
   assert.equal(pm.utilisation,m.pct(pm.booked,110*pm.days_with_rows));
   const cmp=freeze(FROZEN,()=>m.compareTrend('unused_places'));
   const alpha=cmp.series.find(s=>s.name==='Centre Alpha');
   assert.equal(alpha.points[cmp.axis.indexOf('2026-09')],pm.unused_places);

   // COE: available child-days and the measured booking mix.
   const coe=freeze(FROZEN,()=>m.coeOutlook());
   const ca=coe.centres.find(c=>c.owna_id==='a');
   assert.equal(ca.places,110);
   assert.equal(ca.months[0].available_days,110*coe.months[0].operating_days);
   assert.equal(coe.group.places,coe.centres.reduce((s,c)=>s+c.places,0));
   const ms=freeze(FROZEN,()=>m.coeMeasured());
   const ma=ms.centres.find(c=>c.owna_id==='a');
   assert.equal(ma.places,110);
   assert.equal(ma.places_filled_pct,m.pct(ma.mix_children,110));
   assert.equal(ma.days_filled_pct,m.pct(ma.mix_child_days,110*5));
   assert.equal(ma.months[0].available_days,110*ma.months[0].operating_days);
  } finally {db.prepare('UPDATE centres SET approved_places=NULL WHERE owna_id=?').run('a');}
  // Cleared again, every figure falls back to the room sum exactly as before.
  assert.deepEqual(freeze(FROZEN,()=>m.utilisationYtd('fy')),before);
 });

 // (e) A centre with no approved places recorded has NO denominator. Every dependent figure must read "—".
 await t.test('a centre with no approved places reads “—”, never 0 or a percentage of zero',async()=>{
  db.prepare("INSERT INTO centres(owna_id,name,capacity,enrolled,opening) VALUES('nl','Centre Unlicensed',0,0,0)").run();
  try{
   assert.equal(m.placesOf('nl'),null);
   const row=freeze(FROZEN,()=>m.overview('2026-09-07','2026-09-11').find(r=>r.owna_id==='nl'));
   assert.equal(row.places,null);
   assert.equal(row.occupancy,null,'no licence means no percentage, not 0%');
   assert.equal(m.totals([row]).places,0);
   // It is not a licensed centre, so it is in no denominator anywhere.
   assert.ok(!freeze(FROZEN,()=>m.utilisationYtd('fy')).byOwna.nl);
   assert.ok(!m.seatsFilled('2026-09-07','2026-09-11').byOwna.nl);
   assert.ok(!freeze(FROZEN,()=>m.coeOutlook()).centres.some(c=>c.owna_id==='nl'));
   // …and where places are unknown for a centre that DOES have booking rows, the month reads as unknown.
   const pm=m.placesByMonth('a',null,'2026-09','2026-09')[0];
   assert.equal(pm.places,null);assert.equal(pm.unused_places,null);assert.equal(pm.utilisation,null);
   assert.ok(pm.booked>0,'the booked child-days are still counted — only the ratio is unknowable');

   const cookie=await login('admin');
   const html=await freeze(FROZEN,()=>page('/?from=2026-09-07&to=2026-09-11',cookie));
   const cell=html.split('href="/centre/nl?')[1].slice(0,300); // the table row, not the sidebar link
   assert.match(cell,/<td>—<\/td>/,'the Places column must be an em dash');
   assert.doesNotMatch(cell,/\d+%/,'no percentage may be printed against an unlicensed centre');
   assert.match(html,/approved places/i,'the page still says what "places" means');
  } finally {db.prepare("DELETE FROM centres WHERE owna_id='nl'").run();}
 });

 // (a) The nightly pull keeps refreshing the room sum and must never touch the licensed count — nor wipe a
 // service approval number OWNA does not carry (Heath Rd's).
 await t.test('a snapshot run rewrites the room sum and leaves approved places alone',()=>{
  const was=db.prepare('SELECT * FROM centres WHERE owna_id=?').get('a');
  db.prepare('UPDATE centres SET approved_places=124, approval_no=? WHERE owna_id=?').run('SE-00017004','a');
  try{
   // Exactly the row services/snapshot.js writes for a centre each night: a changed room sum, and no
   // service approval number in the OWNA payload.
   snap.upsertCentreRow({owna_id:'a',name:'Centre Alpha',alias:null,suburb:'Austral',state:'NSW',
     capacity:118,enrolled:198,closed:0,approval_no:null,last_updated:'2026-09-12T00:00:00Z'});
   const after=db.prepare('SELECT capacity,approved_places,approval_no FROM centres WHERE owna_id=?').get('a');
   assert.equal(after.capacity,118,'the room sum is still refreshed every night');
   assert.equal(after.approved_places,124,'the licensed count survives the snapshot');
   assert.equal(after.approval_no,'SE-00017004','a number OWNA does not carry is not wiped to NULL');
   assert.equal(m.placesOf('a'),124);
   // And when OWNA does send one, it wins.
   snap.upsertCentreRow({owna_id:'a',name:'Centre Alpha',alias:null,suburb:null,state:null,
     capacity:100,enrolled:198,closed:0,approval_no:'SE-99999999',last_updated:null});
   assert.equal(db.prepare('SELECT approval_no a FROM centres WHERE owna_id=?').get('a').a,'SE-99999999');
  } finally {
   db.prepare('UPDATE centres SET name=?,alias=?,suburb=?,state=?,capacity=?,enrolled=?,closed=?,approval_no=?,last_updated=?,approved_places=NULL WHERE owna_id=?')
     .run(was.name,was.alias,was.suburb,was.state,was.capacity,was.enrolled,was.closed,was.approval_no,was.last_updated,'a');
  }
 });

 // (c) The admin form that maintains it.
 await t.test('/admin/places saves, clears and rejects rubbish, and only admin or ops may reach it',async()=>{
  db.prepare('INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,?)')
    .run('ops_manager@example.test','Ops',bcrypt.hashSync(pass,4),'ops_manager');
  const post=(cookie,body)=>fetch(base+'/admin/places',{method:'POST',redirect:'manual',
    headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});
  const placesOf=(id)=>db.prepare('SELECT approved_places p FROM centres WHERE owna_id=?').get(id).p;

  // Every role that may not write is refused, and the refusal writes nothing.
  for(const role of ['viewer','exec','centre']){
   const c=await login(role);
   assert.equal((await request('/admin/places',c)).status,403,role+' must not read the form');
   assert.equal((await post(c,{places_a:'150'})).status,403,role+' must not post to it');
  }
  assert.equal(placesOf('a'),null,'a refused submission must not land');

  const admin=await login('admin');
  const form=await page('/admin/places',admin);
  assert.match(form,/name="places_a"/);
  assert.match(form,/Centre Alpha/);
  assert.match(form,/OWNA room sum/,'the room sum is shown beside the licensed count so a gap is visible');

  // Saves.
  let r=await post(admin,{places_a:'110',places_b:''});
  assert.equal(r.status,302);assert.match(r.headers.get('location'),/saved=1/);
  assert.equal(placesOf('a'),110);assert.equal(placesOf('b'),null);
  // The discrepancy against the OWNA room sum is on the page.
  assert.match(await page('/admin/places',admin),/\+10/);

  // Rejects rubbish — and rejects the WHOLE submission, so nothing is half-saved.
  for(const bad of ['abc','0','-5','501','12.5']){
   const bad_r=await post(admin,{places_a:bad,places_b:'120'});
   assert.equal(bad_r.status,302,bad);
   assert.match(decodeURIComponent(bad_r.headers.get('location')),/err=/,bad+' must be rejected');
   assert.equal(placesOf('a'),110,bad+' must not overwrite a good value');
   assert.equal(placesOf('b'),null,bad+' must not let the rest of the form through');
  }

  // Blank clears it back to "not recorded" — null, not 0.
  r=await post(admin,{places_a:''});
  assert.equal(r.status,302);
  assert.equal(placesOf('a'),null);

  // Ops managers maintain it too, and get the nav link an admin gets.
  const ops=await login('ops_manager');
  assert.equal((await request('/admin/places',ops)).status,200);
  r=await post(ops,{places_a:'124'});
  assert.equal(r.status,302);assert.match(r.headers.get('location'),/saved=1/);
  assert.equal(placesOf('a'),124);
  assert.match(await page('/',ops),/href="\/admin\/places"/);
  assert.match(await page('/',admin),/href="\/admin\/places"/);
  assert.doesNotMatch(await page('/',await login('exec')),/href="\/admin\/places"/);

  db.prepare('UPDATE centres SET approved_places=NULL WHERE owna_id=?').run('a');
 });

 // ===== Batch H: the COE target is the REAL per-centre target, not a 95% placeholder =====
 // The business already stores an occupancy target per centre, in labour_budget.budget_occ at the standing
 // 'default' week — Austral, Bardia and GWH on 102, Heath Rd on 85. The COE page coloured everything
 // against one hard-coded 95 instead, so Heath Rd was judged against a number 10 points above the one it is
 // actually managed to and the other three against one 7 points below. The row is keyed by the EMPLOYMENT
 // HERO centre name, so every lookup goes through services/eh-labour.js ownaIdFor() rather than a second
 // copy of that mapping.
 const EH_ALPHA='Futuro Alpha', EH_BETA='Futuro Beta';
 const setTarget=(eh,occ,wages)=>db.prepare(
   `INSERT INTO labour_budget(eh_centre,week_ending,budget_wages,budget_hours,budget_occ,budget_support)
    VALUES(?,'default',?,NULL,?,NULL)
    ON CONFLICT(eh_centre,week_ending) DO UPDATE SET budget_wages=excluded.budget_wages, budget_occ=excluded.budget_occ`
 ).run(eh,wages==null?null:wages,occ);
 const clearTargets=()=>db.prepare("DELETE FROM labour_budget WHERE week_ending='default'").run();

 await t.test('the Employment Hero name → owna_id mapping resolves all four operating centres',()=>{
  // The REAL names on both sides, so a rename on either system fails here rather than on the page.
  const { ownaIdFor }=require('../services/eh-labour');
  const real=[
   {owna_id:'669597770e27307b6e0eb590',name:'Futuro Childcare & Education - Austral'},
   {owna_id:'65f7d76df54b2cd83721524a',name:'Futuro Childcare & Education - Bardia'},
   {owna_id:'64547c8b8e248030d4902e9f',name:'Futuro Childcare & Education - Gledswood Hills'},
   {owna_id:'686464706375331b2aae486d',name:'Futuro Childcare & Education - Heath Rd'},
  ];
  assert.equal(ownaIdFor('Futuro Austral',real),'669597770e27307b6e0eb590');
  assert.equal(ownaIdFor('Futuro Bardia',real),'65f7d76df54b2cd83721524a');
  assert.equal(ownaIdFor('Futuro GWH',real),'64547c8b8e248030d4902e9f','the GWH alias must reach Gledswood Hills');
  assert.equal(ownaIdFor('Futuro Heath Rd',real),'686464706375331b2aae486d');
  // …and payroll locations that are not centres resolve to nothing, so they can never carry a COE target.
  assert.equal(ownaIdFor('Futuro HQ',real),null);
  assert.equal(ownaIdFor('Futuro Food Project',real),null);
  // Every one of the four is distinct: a mapping that collapsed two centres would silently share a target.
  const ids=['Futuro Austral','Futuro Bardia','Futuro GWH','Futuro Heath Rd'].map((n)=>ownaIdFor(n,real));
  assert.equal(new Set(ids).size,4);

  // Through the metrics accessor, against this fixture DB, the same mapping keys the stored row.
  setTarget(EH_ALPHA,102,50000);
  try{
   assert.equal(m.ehCentreMap().byEh[EH_ALPHA],'a');
   assert.equal(m.ehCentreFor('a'),EH_ALPHA);
   assert.equal(m.ehCentreFor('b'),null,'a centre payroll has never seen has no name to key a target on');
  } finally {clearTargets();}
 });

 await t.test('a centre with a stored target is judged against it; one without falls back and is labelled',()=>{
  setTarget(EH_ALPHA,102,50000);                 // Alpha is managed to 102%
  db.prepare(`INSERT INTO labour_weekly(eh_centre,week_ending,owna_id,updated_at) VALUES(?,?,?,datetime('now'))
              ON CONFLICT(eh_centre,week_ending) DO NOTHING`).run(EH_BETA,'2026-09-11','b'); // Beta is known to payroll…
  try{
   const t2=m.occupancyTargets();
   assert.deepEqual(t2.a,{pct:102,source:'centre',eh_centre:EH_ALPHA});
   assert.deepEqual(t2.b,{pct:95,source:'default',eh_centre:EH_BETA},'…but has no target stored, so it falls back');
   assert.equal(m.GROUP_TARGET_PCT,95,'the fallback is the single group default, not a per-page constant');

   const coe=freeze(FROZEN,()=>m.coeOutlook());
   const a=coe.centres.find((c)=>c.owna_id==='a'), b=coe.centres.find((c)=>c.owna_id==='b');
   assert.equal(a.target_pct,102);assert.equal(a.target_source,'centre');assert.equal(a.target_eh_centre,EH_ALPHA);
   assert.equal(b.target_pct,95);assert.equal(b.target_source,'default');
   // The gap is to the centre's OWN target, in child-days, month by month.
   a.months.forEach((x)=>{
    assert.equal(x.target_pct,102);
    assert.equal(x.target_days,Math.round(x.available_days*1.02*10)/10);
    assert.equal(x.gap_days,Math.round(Math.max(0,x.available_days*1.02-x.projected_days)*10)/10);
   });
   b.months.forEach((x)=>{ assert.equal(x.target_pct,95); });
   // target_pct at the top level keeps its old meaning — the FALLBACK — so nothing reading it silently changed.
   assert.equal(coe.target_pct,95);assert.equal(coe.target_default_pct,95);
   assert.equal(coe.targets_stored,1);assert.equal(coe.targets_default,coe.centres.length-1);

   // The group target is the centre targets weighted by approved places, not their mean and not the fallback.
   const places=coe.centres.reduce((s,c)=>s+c.places,0);
   const weighted=coe.centres.reduce((s,c)=>s+c.places*c.target_pct,0)/places;
   assert.equal(coe.group.target_pct,Math.round(weighted*10)/10);
   assert.ok(coe.group.target_pct>95,'one centre on 102 must pull the group above the 95 fallback');
   coe.group.months.forEach((x)=>{
    assert.equal(x.gap_days,Math.round(Math.max(0,x.target_days-x.projected_days)*10)/10);
    // Counted centre by centre the shortfall is never smaller: a centre over its target cannot fill a seat
    // at one under it, so the two numbers are different on purpose and both are printed.
    assert.ok(x.shortfall_days>=x.gap_days-0.05,x.month);
   });

   // The measured half is judged the same way — days filled is the measure the stored target is set against.
   const ms=freeze(FROZEN,()=>m.coeMeasured());
   if(ms){
    const ma=ms.centres.find((c)=>c.owna_id==='a');
    if(ma){assert.equal(ma.target_pct,102);assert.equal(ma.target_source,'centre');}
    assert.equal(ms.group.target_pct,m.blendedTarget(ms.centres,m.occupancyTargets()));
   }
  } finally {clearTargets();db.prepare("DELETE FROM labour_weekly WHERE eh_centre=?").run(EH_BETA);}
 });

 await t.test('the COE page says, per centre, which target it is measuring against',async()=>{
  setTarget(EH_ALPHA,102,50000);
  try{
   const adminCookie=await login('admin');
   const html=await freeze(FROZEN,()=>page('/coe',adminCookie));
   assert.match(html,/What each centre is measured against/);
   // Every centre's own target is printed beside its name, and the fallback is named as a fallback.
   assert.match(html,/Centre Alpha[\s\S]{0,400}?<strong>102%<\/strong>/);
   assert.match(html,/its own stored target/);
   assert.match(html,/Centre Beta[\s\S]{0,600}?group default/);
   // …and the colour follows the centre's own target, not one number for the page.
   assert.match(html,/Centre Alpha is measured against 102%/);
   assert.match(html,/Centre Beta is measured against 95%/);
   assert.match(html,/Centre Alpha 102%, Centre Beta 95%/);
   // (b) A target over 100% is explained where it is shown — accurately.
   assert.match(html,/A target above 100% of approved places is not a mistake/);
   assert.match(html,/an absent child still holds the place/);
   assert.match(html,/A centre is over its\s+licence only if more children <em>attend<\/em> on the same day than it is licensed for/);
   assert.match(html,/not<\/strong> reached by part-time families sharing a place across the week/,
     'the page must not offer the wrong reason: sharing lifts children-per-place, never days filled');
   assert.doesNotMatch(html,/placeholder/i);
   // (c) admin and ops get the way to change it; a viewer is told where it lives instead of being sent there.
   assert.match(html,/href="\/admin\/places#targets"/);
   const viewerCookie=await login('viewer');
   const viewer=await freeze(FROZEN,()=>page('/coe',viewerCookie));
   assert.doesNotMatch(viewer,/Set targets/);
   assert.match(viewer,/Targets are maintained by an administrator or the operations manager/);
   assert.match(viewer,/<strong>102%<\/strong>/,'a viewer still sees what each centre is measured against');
  } finally {clearTargets();}
 });

 await t.test('/admin/places edits the SAME stored target the wage page writes, never a second copy',async()=>{
  const admin=await login('admin');
  setTarget(EH_ALPHA,102,50000);
  // Payroll has imported this centre, so the wage page lists it too — both forms must reach the same row.
  db.prepare(`INSERT INTO labour_weekly(eh_centre,week_ending,owna_id,updated_at) VALUES(?,?,?,datetime('now'))
              ON CONFLICT(eh_centre,week_ending) DO NOTHING`).run(EH_ALPHA,'2026-09-11','a');
  const occOf=(eh)=>{const r=db.prepare("SELECT budget_occ o, budget_wages w FROM labour_budget WHERE eh_centre=? AND week_ending='default'").get(eh);return r||{};};
  try{
   const form=await page('/admin/places',admin);
   assert.match(form,/name="target_a"/,'the target is editable beside the places it is a percentage of');
   assert.match(form,/value="102"/);
   assert.doesNotMatch(form,/name="target_b"/,'a centre with no payroll name has nothing to key a target on');
   assert.match(form,/no payroll centre yet/);

   const post=(cookie,body)=>fetch(base+'/admin/places',{method:'POST',redirect:'manual',
     headers:{cookie,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});
   let r=await post(admin,{target_a:'97.5'});
   assert.equal(r.status,302);assert.match(r.headers.get('location'),/targets=1/);
   assert.equal(occOf(EH_ALPHA).o,97.5,'it writes the one stored row…');
   assert.equal(occOf(EH_ALPHA).w,50000,'…and leaves the wage budget on that row alone');
   assert.equal(db.prepare("SELECT COUNT(*) n FROM labour_budget WHERE week_ending='default'").get().n,1,'no second copy');
   assert.equal(m.occupancyTargets().a.pct,97.5);

   // Over 100 is legitimate here and must be accepted; rubbish and a typo like 1020 must not be.
   r=await post(admin,{target_a:'102'});
   assert.match(r.headers.get('location'),/targets=1/);assert.equal(occOf(EH_ALPHA).o,102);
   for(const bad of ['abc','0','-5','1020','97.55']){
    const br=await post(admin,{target_a:bad,places_a:'110'});
    assert.match(decodeURIComponent(br.headers.get('location')),/err=/,bad+' must be rejected');
    assert.equal(occOf(EH_ALPHA).o,102,bad+' must not overwrite a good target');
    assert.equal(db.prepare("SELECT approved_places p FROM centres WHERE owna_id='a'").get().p,null,
      bad+' must not let the rest of the form through');
   }
   // Blank clears it back to the group default rather than storing a zero.
   r=await post(admin,{target_a:''});
   assert.match(r.headers.get('location'),/targets=1/);
   assert.equal(occOf(EH_ALPHA).o,null);
   assert.deepEqual(m.occupancyTargets().a,{pct:95,source:'default',eh_centre:EH_ALPHA});
   // The wage-budget page still edits the very same row, so the two forms cannot drift apart.
   const wage=await page('/admin/wage-budget',admin);
   assert.match(wage,new RegExp('name="occ_'+EH_ALPHA.replace(/ /g,'\\s')+'"'));
  } finally {clearTargets();db.prepare("DELETE FROM labour_weekly WHERE eh_centre=?").run(EH_ALPHA);
             db.prepare("UPDATE centres SET approved_places=NULL WHERE owna_id='a'").run();}
 });
 } finally {
  // server.close() only stops the listener and then WAITS for every open connection. Node's fetch
  // keeps its sockets alive between requests, so with enough requests in one file there is always an
  // idle keep-alive socket left and close() never calls back — the file's tests all pass and then the
  // process sits there until the runner gives up. Drop the connections first, and stop the session
  // store's sweep, so teardown is deterministic rather than a race with a keep-alive timeout.
  require('../middleware/session').store.stopPruning();
  if (typeof server.closeAllConnections==='function') server.closeAllConnections();
  await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

// ===== Batch F — a restore must not reinstate the logins that were live when the backup was taken =====
// docs/outstanding.md asserted that a restored backup's session rows were "expired and swept on the first
// start". They are not. `expire` is the last request + 8h, and the boot sweep (the vendored
// clearExpiredSessions, DELETE ... WHERE datetime('now') > datetime(expire)) removes only rows already
// past it — so every row in a backup younger than eight hours outlives the sweep, which is exactly the
// "back up at 11:00, bad import at 12:30, restore at 13:00" case the command exists for. Worse, logging
// out deletes the row but not the browser cookie (routes/auth.js destroys the session without
// res.clearCookie), so a resurrected row signs a logged-out user back in. scripts/restore-db.js now
// clears the table on the restored file.
test('Week 2 batch F — restore clears the sessions the backup was carrying',async(t)=>{
 const Database=require('better-sqlite3'), {execFileSync}=require('child_process');
 const bdir=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-week2-restore-'));
 const src=path.join(bdir,'source.db'), enc=path.join(bdir,'backup.db.enc'), restored=path.join(bdir,'restored.db');
 const PASS='week2-restore-fixture-passphrase';
 const SWEEP="DELETE FROM sessions WHERE datetime('now') > datetime(expire)"; // the boot sweep, verbatim
 try{
  // A database as it stands at backup time: one centre row, and two logins written the way the store
  // writes them (expire = now + the eight-hour cookie, ISO-8601).
  const live=new Database(src);
  live.exec('CREATE TABLE sessions (sid TEXT NOT NULL PRIMARY KEY, sess JSON NOT NULL, expire TEXT NOT NULL);'
           +'CREATE TABLE centres (owna_id TEXT PRIMARY KEY, name TEXT)');
  live.prepare('INSERT INTO centres VALUES(?,?)').run('a','Centre Alpha');
  const ins=live.prepare('INSERT INTO sessions(sid,sess,expire) VALUES(?,?,?)');
  const sess=(id,email)=>JSON.stringify({cookie:{maxAge:8*60*60*1000},user:{id,email,role:'centre'}});
  ins.run('live-sid',sess(3,'director@example.test'),new Date(Date.now()+8*60*60*1000).toISOString());
  ins.run('logged-out-sid',sess(4,'relief@example.test'),new Date(Date.now()+7*60*60*1000).toISOString());
  await require('../services/backup').backup(live,enc,PASS);
  // The backup is minutes old, so the boot sweep would not touch either row: nothing but an explicit
  // clear on the restored file removes them. If this ever stops holding the assertions below prove less.
  assert.equal(live.prepare(SWEEP).run().changes,0,'the boot sweep must be unable to expire a fresh backup');
  live.close();

  // Someone logs out after the backup — the row goes, the browser keeps the signed sid.
  const after=new Database(src);after.prepare('DELETE FROM sessions WHERE sid=?').run('logged-out-sid');after.close();

  const out=execFileSync(process.execPath,[path.join(__dirname,'..','scripts','restore-db.js'),enc,restored],
    {env:{...process.env,BACKUP_PASSPHRASE:PASS},encoding:'utf8'});
  assert.match(out,/integrity check passed/);

  const d=new Database(restored,{readonly:true});
  try{
   assert.equal(d.pragma('integrity_check',{simple:true}),'ok');
   assert.equal(d.prepare('SELECT COUNT(*) n FROM centres').get().n,1,'the restore must still restore the data');
   assert.equal(d.prepare('SELECT COUNT(*) n FROM sessions').get().n,0,'a restore must not carry logins back in');
   // The store's own read, for the cookie the logged-out user still holds: no row, so no sign-in.
   assert.equal(d.prepare("SELECT sess FROM sessions WHERE sid=? AND datetime('now') < datetime(expire)").get('live-sid'),undefined);
  } finally {d.close();}

  // A backup from before the sessions table existed still restores; there is simply nothing to clear.
  const old=path.join(bdir,'old.db'), oldEnc=path.join(bdir,'old.db.enc'), oldOut=path.join(bdir,'old-restored.db');
  const o=new Database(old);o.exec('CREATE TABLE centres (owna_id TEXT PRIMARY KEY, name TEXT)');
  o.prepare('INSERT INTO centres VALUES(?,?)').run('b','Centre Beta');
  await require('../services/backup').backup(o,oldEnc,PASS);o.close();
  execFileSync(process.execPath,[path.join(__dirname,'..','scripts','restore-db.js'),oldEnc,oldOut],
    {env:{...process.env,BACKUP_PASSPHRASE:PASS},encoding:'utf8'});
  const od=new Database(oldOut,{readonly:true});
  try{assert.equal(od.prepare('SELECT COUNT(*) n FROM centres').get().n,1);}finally{od.close();}
 } finally {fs.rmSync(bdir,{recursive:true,force:true});}
});

// ===== Batch G — the approved-places migration =====
// The licensed count cannot come from OWNA, so db/init-schema.js seeds it from the ACECQA National Register
// on boot. Two things have to hold forever: it only ever fills a NULL (an admin's correction at
// /admin/places must survive every reboot), and running it again changes nothing.
test('Week 2 batch G — the approved-places migration seeds only nulls and is idempotent', () => {
 const Database=require('better-sqlite3');
 const {initSchema}=require('../db/init-schema');
 const mdir=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-week2-places-'));
 const d=new Database(path.join(mdir,'migrate.db'));
 try{
  initSchema(d);                                   // boot 1: an empty database — the column appears, nothing to seed
  assert.ok(d.prepare('PRAGMA table_info(centres)').all().some(c=>c.name==='approved_places'),'approved_places must be added to centres');

  // The group as OWNA leaves it: room sums, three approval numbers and none for Heath Rd, plus the
  // pre-opening centres that have no service approval on the register at all.
  const ins=d.prepare('INSERT INTO centres(owna_id,name,capacity,approval_no,approved_places,opening) VALUES(?,?,?,?,?,?)');
  ins.run('1','Futuro Childcare & Education - Austral',122,'SE-00017004',null,0);
  ins.run('2','Futuro Childcare & Education - Bardia',122,'SE-00016692',null,0);
  ins.run('3','Futuro Childcare & Education - Gledswood Hills',119,'SE-40025191',null,0);
  ins.run('4','Futuro Childcare & Education - Heath Rd',136,null,null,0);
  ins.run('ll-6','Futuro Childcare & Education Cobbitty',0,null,null,1);
  ins.run('ll-7','Futuro Childcare & Education - Austral Fields',0,null,null,1); // a pre-opening name that MATCHES a seed
  ins.run('ll-8','Futuro Childcare & Education - Oran Park',0,null,null,1);
  ins.run('ll-9','Futuro Childcare & Education - Park Rd',0,null,null,1);

  const read=()=>d.prepare('SELECT owna_id,capacity,approved_places,approval_no FROM centres ORDER BY owna_id').all();
  initSchema(d);                                   // boot 2: the seed runs
  const seeded=read();
  assert.deepEqual(seeded.map(r=>[r.owna_id,r.approved_places]),
    [['1',124],['2',122],['3',119],['4',136],['ll-6',null],['ll-7',null],['ll-8',null],['ll-9',null]],
    'the four operating services take the register figures; a pre-opening centre stays unknown even when its name matches');
  assert.equal(seeded.find(r=>r.owna_id==='4').approval_no,'SE-00018172','Heath Rd gets the number OWNA does not return');
  const operating=seeded.filter(r=>!String(r.owna_id).startsWith('ll-'));
  assert.equal(operating.reduce((s,r)=>s+r.capacity,0),499,'the OWNA room sums add to 499…');
  assert.equal(operating.reduce((s,r)=>s+r.approved_places,0),501,'…but the group is licensed for 501 places');
  assert.equal(seeded.find(r=>r.owna_id==='1').approved_places-seeded.find(r=>r.owna_id==='1').capacity,2,'Austral is the discrepancy: 124 licensed against 122 rooms');

  // Boot 3 changes nothing at all.
  initSchema(d);
  assert.deepEqual(read(),seeded,'a second boot must be a no-op');

  // An admin corrects Austral by hand at /admin/places, and clears Bardia back to "not recorded".
  // Two more boots must leave the correction as typed — and must re-seed only what is genuinely NULL.
  d.prepare("UPDATE centres SET approved_places=126 WHERE owna_id='1'").run();
  d.prepare("UPDATE centres SET approved_places=NULL WHERE owna_id='2'").run();
  initSchema(d); initSchema(d);
  assert.equal(d.prepare("SELECT approved_places p FROM centres WHERE owna_id='1'").get().p,126,"an admin's edit is never overwritten on reboot");
  assert.equal(d.prepare("SELECT approved_places p FROM centres WHERE owna_id='2'").get().p,122,'a cleared value is re-seeded from the register');
 } finally {d.close();fs.rmSync(mdir,{recursive:true,force:true});}
});

// ===== Batch H — a write from the site itself must not be refused =====
// On the deployed site (Cloudflare in front of Render) every form submission came back as a bare
// "Forbidden": saving approved places, generating a briefing, everything. The cross-origin guard
// compared the Origin's host to the raw `Host` header, and behind a proxy chain those are not
// reliably the same string — a port may be added or dropped, and the address the browser actually
// used can arrive only as X-Forwarded-Host. It now compares hostnames against every hostname the
// request could legitimately have been made to, and says what happened instead of one bare word.
test('Week 2 batch H — a same-site write survives a proxy; a cross-site one is still refused', async (t) => {
 const dir2=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-week2-origin-'));
 const prev=process.env.DB_PATH, prevPublic=process.env.PUBLIC_HOSTNAME;
 process.env.DB_PATH=path.join(dir2,'origin.db');
 for(const k of Object.keys(require.cache)) if(k.startsWith(path.join(__dirname,'..'))&&!k.includes('node_modules')&&k!==__filename) delete require.cache[k];
 const d2=require('../db/db'), app2=require('../server');
 d2.prepare('INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,?)').run('origin@example.test','Origin Fixture',bcrypt.hashSync(pass,4),'admin');
 const s3=app2.listen(0,'127.0.0.1'); await new Promise(r=>s3.once('listening',r));
 const b3='http://127.0.0.1:'+s3.address().port, hostHeader='127.0.0.1:'+s3.address().port;
 try{
  const lr=await fetch(b3+'/login',{method:'POST',body:new URLSearchParams({email:'origin@example.test',password:pass}),redirect:'manual'});
  const cookie=lr.headers.get('set-cookie').split(';')[0];
  const post=(headers)=>fetch(b3+'/feedback',{method:'POST',redirect:'manual',
    headers:{cookie,'content-type':'application/x-www-form-urlencoded',...headers},body:'area=overview&category=idea&message=hello'});

  // The plain same-origin case: the browser's Origin is exactly the host it asked for.
  assert.notEqual((await post({origin:'http://'+hostHeader})).status,403,'a write from the site itself must not be refused');
  // Behind a TLS-terminating proxy the scheme differs and the port is dropped from Origin, while
  // Host still carries one. Comparing the raw strings refused this — which is the production bug.
  assert.notEqual((await post({origin:'https://127.0.0.1'})).status,403,'a dropped port must not refuse the write');
  // The address the browser used can reach the app only as X-Forwarded-Host.
  assert.notEqual((await post({origin:'https://futuro-pulse.onrender.com','x-forwarded-host':'futuro-pulse.onrender.com'})).status,403,
    'the forwarded host is the address the browser used, and must be accepted');
  // A canonical hostname can also be pinned by configuration, for a proxy that forwards neither.
  process.env.PUBLIC_HOSTNAME='pulse.futuro.nsw.edu.au';
  assert.notEqual((await post({origin:'https://pulse.futuro.nsw.edu.au'})).status,403,'the configured public hostname must be accepted');
  delete process.env.PUBLIC_HOSTNAME;

  // What the guard is actually for: another site posting with the user's cookie. Still refused —
  // and now with a page that explains it, not the single word that left nobody any wiser.
  const evil=await post({origin:'https://attacker.example'});
  assert.equal(evil.status,403,'a genuinely cross-site write must still be refused');
  const body=await evil.text();
  assert.match(body,/different web address/,'the refusal must explain itself');
  assert.doesNotMatch(body,/^Forbidden$/,'a bare "Forbidden" tells the reader nothing');
  // The header that caused all of this. Chrome ties the Origin header on a form submission to the
  // page's referrer policy: under "no-referrer" it sends `Origin: null`, so the app's OWN forms
  // looked cross-site and every write on the deployed site was refused. "same-origin" still stops a
  // dashboard URL (which can name a centre) reaching another site, and keeps the Origin header.
  const hdrs=(await fetch(b3+'/',{headers:{cookie},redirect:'manual'})).headers;
  assert.equal(hdrs.get('referrer-policy'),'same-origin','no-referrer strips Origin from our own form posts');
  assert.equal(hdrs.get('x-frame-options'),'DENY');
  assert.equal(hdrs.get('cache-control'),'no-store');
  // An opaque origin is still refused — but it should no longer be what our own browser sends.
  assert.equal((await post({origin:'null'})).status,403,'an opaque origin is not the site');
  // A GET is never checked: only writes carry this risk, and the cookie is SameSite=lax anyway.
  assert.equal((await fetch(b3+'/',{headers:{cookie,origin:'https://attacker.example'},redirect:'manual'})).status,200);
 } finally {
  if(typeof s3.closeAllConnections==='function') s3.closeAllConnections();
  await new Promise(r=>s3.close(r)); require('../middleware/session').store.stopPruning(); d2.close();
  fs.rmSync(dir2,{recursive:true,force:true});
  if(prevPublic===undefined) delete process.env.PUBLIC_HOSTNAME; else process.env.PUBLIC_HOSTNAME=prevPublic;
  process.env.DB_PATH=prev;
 }
});

// ===== Under construction =====
// MAINTENANCE=1 puts the dashboard behind a holding page while pages are being reworked, without
// taking the service down or deploying different code. It has to do three things: show trial users
// the page, keep letting admin and ops through so the work can be checked, and answer 503 rather
// than 200 so a monitor or a crawler reads it as temporary.
test('Week 2 batch I — the under-construction page holds everyone but admin and ops', async (t) => {
 const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-maint-'));
 const prevDb = process.env.DB_PATH, prevMode = process.env.MAINTENANCE;
 process.env.DB_PATH = path.join(mdir, 'maint.db');
 process.env.MAINTENANCE = '1';
 for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(__dirname, '..')) && !k.includes('node_modules') && k !== __filename) delete require.cache[k];
 const mdb = require('../db/db'), mapp = require('../server');
 for (const [email, role] of [['boss@example.test', 'admin'], ['ops@example.test', 'ops_manager'], ['dir@example.test', 'exec'], ['look@example.test', 'viewer']])
   mdb.prepare('INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,?)').run(email, role, bcrypt.hashSync(pass, 4), role);
 const srv = mapp.listen(0, '127.0.0.1'); await new Promise(r => srv.once('listening', r));
 const b = 'http://127.0.0.1:' + srv.address().port;
 const signIn = async (email) => {
   const r = await fetch(b + '/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ email, password: pass }) });
   assert.equal(r.status, 302, 'sign-in must keep working while the holding page is up');
   return r.headers.get('set-cookie').split(';')[0];
 };
 const go = (p, cookie) => fetch(b + p, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
 try {
   // A visitor with no login gets the page, not a redirect to sign in, and not a 200.
   const anon = await go('/');
   assert.equal(anon.status, 503, 'a holding page is temporary — it must not answer 200');
   assert.equal(anon.headers.get('retry-after'), '3600');
   const anonBody = await anon.text();
   assert.match(anonBody, /making some changes/i);
   assert.match(anonBody, /sign in/i, 'and it must tell whoever looks after it how to get in');

   // Every route, not just the home page.
   for (const p of ['/coe', '/pipeline', '/wages', '/admin/places', '/ask', '/nothing-here'])
     assert.equal((await go(p)).status, 503, p + ' must be held too');

   // Admin and ops keep working.
   for (const role of ['boss', 'ops']) {
     const c = await signIn(role + '@example.test');
     const r = await go('/', c);
     assert.equal(r.status, 200, role + ' must still reach the dashboard');
     assert.doesNotMatch(await r.text(), /making some changes/i);
   }
   // Everyone else is held, even signed in — and told so by name rather than bounced to a login loop.
   for (const role of ['dir', 'look']) {
     const c = await signIn(role + '@example.test');
     const r = await go('/', c);
     assert.equal(r.status, 503, role + ' must see the holding page');
     assert.match(await r.text(), /cannot see the dashboard while it is offline/i);
   }
   // And with the switch off, nothing is held.
   process.env.MAINTENANCE = '0';
   for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(__dirname, '..')) && !k.includes('node_modules') && k !== __filename) delete require.cache[k];
   const openApp = require('../server'), s2 = openApp.listen(0, '127.0.0.1');
   await new Promise(r => s2.once('listening', r));
   const b2 = 'http://127.0.0.1:' + s2.address().port;
   const lr = await fetch(b2 + '/login', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ email: 'look@example.test', password: pass }) });
   const r2 = await fetch(b2 + '/', { headers: { cookie: lr.headers.get('set-cookie').split(';')[0] }, redirect: 'manual' });
   assert.equal(r2.status, 200, 'with MAINTENANCE off a viewer sees the dashboard again');
   if (typeof s2.closeAllConnections === 'function') s2.closeAllConnections();
   await new Promise(r => s2.close(r));
   require('../middleware/session').store.stopPruning();
 } finally {
   if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
   await new Promise(r => srv.close(r));
   try { require('../middleware/session').store.stopPruning(); } catch {}
   mdb.close(); fs.rmSync(mdir, { recursive: true, force: true });
   if (prevMode === undefined) delete process.env.MAINTENANCE; else process.env.MAINTENANCE = prevMode;
   process.env.DB_PATH = prevDb;
 }
});
