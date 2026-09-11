// Week 1 feature tests: honest booked-ahead labels, seats & utilisation, projection trust note, Reg 12 tile.
// Harness mirrors tests/phase0.test.js: temp DB via DB_PATH, fixture users, app.listen(0). Later batches append t.test blocks.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'pulse-week1-'));
process.env.DB_PATH=path.join(dir,'test.db');process.env.NODE_ENV='test';
process.env.ADMIN_EMAIL='test-admin@example.test';process.env.ADMIN_DEFAULT_PASSWORD='FixturePasswordOnly!';
process.env.SESSION_SECRET='fixture-session-only';process.env.ANTHROPIC_API_KEY='fixture';
const db=require('../db/db'), bcrypt=require('bcryptjs');
const pass='FixturePasswordOnly!';
for(const [id,name,cap,opening] of [['a','Centre Alpha',100,0],['b','Centre Beta',100,0],['open','Centre Opening',0,1]]) db.prepare('INSERT INTO centres(owna_id,name,capacity,opening) VALUES(?,?,?,?)').run(id,name,cap,opening);
for(const role of ['viewer','centre','exec','admin']) db.prepare('INSERT INTO users(email,name,password_hash,role,location_id) VALUES(?,?,?,?,?)').run(role+'@example.test',role,bcrypt.hashSync(pass,4),role,role==='centre'?'a':null);
const m=require('../services/metrics'), cal=require('../services/calendar');
const today=m.todayStr();
const addDays=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
const monthShift=(n)=>{const [y,mo]=today.slice(0,7).split('-').map(Number);return new Date(Date.UTC(y,mo-1+n,1)).toISOString().slice(0,7);};
const dm=db.prepare('INSERT INTO daily_metrics(owna_id,metric_date,capacity,booked,attended,absent,casual,fee_total) VALUES(?,?,100,?,?,?,?,?)');
// King's Birthday week 2026: Mon 8 June is a NSW public holiday — OWNA still carries a booking row (nobody attends).
dm.run('a','2026-06-08',30,0,30,0,600); dm.run('a','2026-06-09',50,45,5,1,1000); dm.run('a','2026-06-10',70,60,10,2,1400);
dm.run('b','2026-06-09',40,40,0,0,800);
// Today (attendance known) and a week ahead (future rows carry OWNA's default "attending" flag).
dm.run('a',today,50,40,10,1,1000); dm.run('a',addDays(today,7),60,60,0,3,1200);
// Incidents: current month, three months back and eleven months back are inside the 12-month window; twelve back is not.
const inc=db.prepare('INSERT INTO incidents_monthly(owna_id,month,total,injuries,illness,serious,reportable) VALUES(?,?,?,?,?,?,?)');
inc.run('a',monthShift(0),10,8,2,0,1); inc.run('a',monthShift(-3),20,15,5,1,2); inc.run('a',monthShift(-11),12,10,2,0,1); inc.run('a',monthShift(-12),30,20,10,2,5);
const app=require('../server');
let server,base;
async function login(role){const r=await fetch(base+'/login',{method:'POST',body:new URLSearchParams({email:role+'@example.test',password:pass}),redirect:'manual'});assert.equal(r.status,302);return r.headers.get('set-cookie').split(';')[0];}
async function request(url,cookie){return fetch(base+url,{headers:{cookie},redirect:'manual'});}
async function page(url,cookie){const r=await request(url,cookie);assert.equal(r.status,200,url+' '+r.status);return r.text();}

test('Week 1 batch 1',async(t)=>{
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;
 try {
 await t.test('calendar counts NSW operating days',()=>{
  assert.equal(cal.operatingDays('2026-07-01','2027-06-30'),253); // FY2026-27: 261 weekdays − 8 weekday holidays
  assert.equal(cal.operatingDays('2026-01-01','2026-12-31'),253);
  assert.equal(cal.operatingDays('2026-06-08','2026-06-12'),4); // King's Birthday week
  assert.equal(cal.operatingDays('2026-09-12','2026-09-13'),0); // weekend
  assert.equal(cal.operatingDays('2026-09-11','2026-09-01'),0); // reversed range
  assert.equal(cal.isOperatingDay('2026-04-25'),false); // Anzac Day (Saturday)
  assert.equal(cal.isOperatingDay('2026-04-24'),true);
  assert.equal(cal.isOperatingDay('2026-10-05'),false); // Labour Day
  assert.deepEqual(cal.unknownHolidayYears('2024-06-01','2025-01-01'),[2024]);
  assert.deepEqual(cal.operatingDayList('2026-04-02','2026-04-07'),['2026-04-02','2026-04-07']); // Easter 2026
 });
 await t.test('yearStart / yearRange follow the 1 July financial year by default',()=>{
  assert.equal(m.yearStart('fy','2026-09-11'),'2026-07-01');
  assert.equal(m.yearStart('fy','2026-03-01'),'2025-07-01');
  assert.equal(m.yearStart('cy','2026-09-11'),'2026-01-01');
  assert.deepEqual(m.yearRange('fy','2026-09-11'),{kind:'fy',start:'2026-07-01',end:'2027-06-30',label:'FY2026-27',ytdLabel:'FYTD'});
  assert.deepEqual(m.yearRange('cy','2026-09-11'),{kind:'cy',start:'2026-01-01',end:'2026-12-31',label:'CY2026',ytdLabel:'CYTD'});
  assert.equal(m.yearRange('bogus','2026-09-11').kind,'fy');
 });
 await t.test('seatsFilled averages booked children over operating days only',()=>{
  const s=m.seatsFilled('2026-06-08','2026-06-12');
  assert.equal(s.operating_days,4);
  assert.deepEqual(s.rows.map(r=>[r.owna_id,r.booked,r.days,r.seats]),[['a',120,2,60],['b',40,1,40]]); // holiday row excluded
  assert.deepEqual(s.group,{booked:160,days:2,seats:80});
  assert.equal(s.byOwna.a.seats,60);
  assert.deepEqual(m.seatsFilled('2026-06-13','2026-06-14').group,{booked:0,days:0,seats:0});
 });
 await t.test('utilisationYtd divides operating-day bookings by places × operating days, with the annual denominator',()=>{
  const u=m.utilisationYtd('fy','2026-06-12');
  assert.equal(u.label,'FY2025-26');assert.equal(u.start,'2025-07-01');assert.equal(u.end,'2026-06-30');assert.equal(u.today,'2026-06-12');
  const opYtd=cal.operatingDays('2025-07-01','2026-06-12');
  assert.equal(u.operating_days_ytd,opYtd);assert.equal(u.operating_days_year,253);
  assert.equal(u.places,200); // pre-opening centre excluded
  assert.deepEqual(u.rows.map(r=>[r.owna_id,r.booked,r.cap_days,r.utilisation]),[['a',120,100*opYtd,m.pct(120,100*opYtd)],['b',40,100*opYtd,m.pct(40,100*opYtd)]]);
  assert.deepEqual(u.group,{booked:160,cap_days:200*opYtd,utilisation:m.pct(160,200*opYtd),capacity:200,annual_child_days:200*253});
  assert.equal(u.annual_child_days,50600);
  const c=m.utilisationYtd('cy','2026-06-12');assert.equal(c.label,'CY2026');assert.equal(c.start,'2026-01-01');assert.equal(c.operating_days_year,253);
 });
 await t.test('overview splits past and booked-ahead days; attendance is past days only',()=>{
  const row=m.overview(today,addDays(today,7)).find(r=>r.owna_id==='a');
  assert.equal(row.days,2);assert.equal(row.past_days,1);assert.equal(row.future_days,1);
  assert.equal(row.booked,110);assert.equal(row.past_booked,50);assert.equal(row.future_booked,60);
  assert.equal(row.attended,40);assert.equal(row.absent,10);assert.equal(row.attendance_rate,80);
  assert.equal(row.fee_total,2200);assert.equal(row.fee_past,1000);assert.equal(row.fee_future,1200);
  const t1=m.totals(m.overview(today,addDays(today,7)));
  assert.equal(t1.attendance_rate,80);assert.equal(t1.fee_future,1200);assert.equal(t1.past_days,1);assert.equal(t1.future_days,1);
  const t0=m.totals(m.overview(today,today));
  assert.equal(t0.attendance_rate,80);assert.equal(t0.fee_future,0);assert.equal(t0.future_days,0);assert.equal(t0.booked,50);
  assert.equal(m.totals([]).attendance_rate,0);
 });
 await t.test('reg12Last12Months sums reportable incidents over the 12 months to now',()=>{
  const r=m.reg12Last12Months('a');
  assert.equal(r.reportable,4);assert.equal(r.months,3);assert.equal(r.from_month,monthShift(-11));assert.equal(r.to_month,monthShift(0));
  assert.equal(r.first_month,monthShift(-11));assert.equal(r.last_month,monthShift(0));
  assert.deepEqual(m.reg12Last12Months('b'),{from_month:monthShift(-11),to_month:monthShift(0),reportable:0,serious:0,total:0,months:0,first_month:null,last_month:null});
  assert.equal(m.reg12Last12Months('a','2026-09-11').from_month,'2025-10');
 });
 await t.test('overview labels booked-ahead ranges honestly and shows seats and utilisation',async()=>{
  const c=await login('admin');
  const ahead=await page(`/?from=${today}&to=${addDays(today,7)}`,c);
  assert.match(ahead,/booked ahead — departures not yet deducted, so this overstates/);
  assert.match(ahead,/past days only/);
  assert.match(ahead,/Fees: billed to date \+ booked ahead/);
  assert.match(ahead,/\$1,000 billed to date · \$1,200 booked ahead/);
  assert.match(ahead,/Fees billed to date \+ booked ahead/); // table header
  assert.match(ahead,/Seats filled, avg per day/);
  assert.match(ahead,/Utilisation FYTD · FY/);
  assert.match(ahead,/Annual denominator FY\d{4}-\d{2} = \d+ operating days/);
  const past=await page(`/?from=${addDays(today,-6)}&to=${today}`,c);
  assert.doesNotMatch(past,/booked ahead/);
  assert.doesNotMatch(past,/past days only/);
  assert.match(past,/Fees billed/);
  assert.match(past,/Seats filled, avg per day/);
  const cy=await page(`/?from=${addDays(today,-6)}&to=${today}&year=cy`,c);
  assert.match(cy,/Utilisation CYTD · CY\d{4}/);
  assert.match(cy,/Showing calendar year/);
  // Seats over King's Birthday week: Alpha 60, Beta 40, group 80 (holiday booking row ignored).
  const kb=await page('/?from=2026-06-08&to=2026-06-12',c);
  assert.match(kb,/2 operating days with bookings/);
  assert.match(kb,/<td class="num">60<\/td>/);assert.match(kb,/<td class="num">40<\/td>/);assert.match(kb,/<td class="num">80<\/td>/);
  // Viewer (aggregates only) and centre-scoped logins render the same tiles for their scope.
  assert.match(await page('/',await login('viewer')),/Seats filled, avg per day/);
  const scoped=await page(`/?from=${today}&to=${addDays(today,7)}`,await login('centre'));
  assert.match(scoped,/booked ahead — departures not yet deducted/);assert.doesNotMatch(scoped,/Centre Beta/);
 });
 await t.test('projection is renamed, sits after the pipeline in the nav and carries the 90-day trust note',async()=>{
  const c=await login('exec');
  const html=await page('/projection',c);
  const iPipe=html.indexOf('>Enrolment Pipeline<'), iProj=html.indexOf('>Enrolment Projection<'), iExit=html.indexOf('>Exit Report<');
  assert.ok(iPipe>0&&iProj>iPipe&&iExit>iProj,'nav order pipeline → projection → exits');
  assert.doesNotMatch(html,/>Projection</);
  assert.match(html,/Trust the first 90 days\.<\/strong> Beyond that the line adds pipeline starts but never deducts departures, so it is a ceiling, not a forecast\./);
  assert.match(html,/next 90 days/);
  assert.match(html,/6 mo · ceiling/);
  assert.doesNotMatch(html,/Projected with pipeline \(ceiling\)/);
  const long=await page('/projection?days=180',c);
  assert.match(long,/next 180 days/);assert.match(long,/Projected with pipeline \(ceiling\)/);assert.match(long,/badge warn">ceiling/);
  assert.match(await page('/projection?days=999',c),/next 90 days/); // default stays 90
 });
 await t.test('Q&C shows the Reg 12 tile for the selected centre and links to Safety',async()=>{
  const c=await login('admin');
  const a=await page('/qc?owna=a',c);
  assert.match(a,/Serious incidents \(Reg 12\), last 12 months/);
  assert.match(a,/Emergency services attended or medical attention sought — the two Reg 12 tests\. Recorded from OWNA incident reports\./);
  assert.match(a,/reg12-stat"><div class="n">4<\/div>/);
  assert.match(a,/3 months of data/);
  assert.match(a,/href="\/safety"/);
  const b=await page('/qc?owna=b',c);
  assert.match(b,/reg12-stat"><div class="n">—<\/div>/);assert.match(b,/No incident data for this centre yet/);
  assert.match(await page('/qc',await login('centre')),/3 months of data/); // scoped to Alpha
  assert.equal((await request('/qc',await login('viewer'))).status,403);
 });
 } finally {await new Promise(r=>server.close(r));db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
