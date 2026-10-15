# Phu Kradueng summit-house bot

Books summit houses (Zone 1, วังกวาง) at Phu Kradueng on nps.dnp.go.th for the CU Photo camp.
It finds houses and puts them in the cart the moment they become bookable. **You** finish the booking:
tick the reCAPTCHA and press บันทึก (Save) within the ~10-minute cart hold. It never pays.

## Control panel (easiest)
```
node gui.mjs
```
Opens a page in your browser: set dates and houses, save your login, then press **Start bot**.
The log streams live. Keep that terminal open. The Mac is kept awake while the bot runs.

## How it decides a date is open
The site's search lists houses as free even for dates that can't be booked yet. So the bot asks the site
for its latest bookable check-in date (the "ไม่เกินวันที่ …" value). When that reaches your check-in date,
it immediately sends the reserve requests for your houses (their IDs are looked up in advance).

## Setup (once)
```
npm install
node bot.mjs login
```
Put your login in `credentials.json` (`id_card` = เลขบัตรประชาชน, `password`), or set the env vars
`DNP_ID_CARD` / `DNP_PASSWORD`. The bot fills the login form; you tick the reCAPTCHA (the site
requires it on every login) and the bot presses login. The session is kept in `.chrome-profile/`,
and the bot asks you to log in again if it ever gets logged out.
Keep `credentials.json` private: don't share or upload it.

## Before booking day
Edit `config.json`:
- `check_in` / `check_out`: YYYY-MM-DD. Max 3 nights per booking, so split longer stays.
- `houses`: house numbers in priority order, e.g. `"111/1"` or `"104"`. Run `node bot.mjs check` to see names.
- `max_houses`: how many houses to grab.
- `open_date`: `"auto"` = check-in minus 59 days. `open_times`: when to poll (Bangkok time).
- `pay_method`: `"bank"` (Krungthai counter/ATM by 20:00) or `"office"` (DNP office by 16:30).
- `book_for`: name of the actual guest (leave blank to keep the account holder's name).

## On booking day
```
node bot.mjs run
```
Leave the laptop awake and plugged in. When it chimes and says "tick the captcha", go to the Chrome window,
check the cart, tick "I'm not a robot" and press บันทึก. Then pay by the deadline shown.

Site rules: book ≤60 days ahead, ≤3 nights, one date change (≥10 working days before), **no refunds after payment**.
