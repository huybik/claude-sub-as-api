// Each profile's subscription quota, as Claude Code reports it in a rate_limit_event on every call, and the profile a
// call without x-local-profile uses. Those calls stay on one profile until it is spent: a prompt cache belongs to one
// account, so a conversation that moves writes its prefix again on the next one.

// Weekly caps that cover one model family. Any other rejection spends the whole profile.
const familyLimits = { seven_day_opus: 'opus', seven_day_sonnet: 'sonnet' };
const family = model => ['opus', 'sonnet'].find(name => model.includes(name)) ?? 'other';
// How long a proxy profile's refusal without a reset time holds it.
const proxyRefusalHold = 60_000;
const spentUntil = (report, model, now) => {
  const until = Math.max(report?.spent.all ?? 0, report?.spent[family(model)] ?? 0, report?.refusedUntil ?? 0);
  return until > now ? until : 0;
};
// Paid extra usage lasts until the plan window that ran out resets.
const onExtraUsage = (report, now) => report?.info.isUsingOverage === true && report.info.resetsAt * 1000 > now;

export class ProfileQuota {
  reports = new Map(); // `${profile}\n${login}` -> the newest call's rate_limit_info, and each spent scope's reset.

  constructor(names, loginOf, proxied) {
    this.names = names;
    this.loginOf = loginOf;
    this.proxied = proxied;
    this.current = names[0];
  }

  // rate_limit_info from a call that started at `started` on this profile and login.
  record(profile, login, info, started) {
    const key = `${profile}\n${login}`;
    const report = this.reports.get(key) ?? { spent: {}, started: -Infinity };
    // Claude Code's own rule: rejected without extra usage refuses calls until resetsAt (seconds). A call admitted
    // before the limit can still report allowed afterwards, so only the reset ends a spent scope.
    const rejected = info.status === 'rejected' && !info.isUsingOverage;
    if (rejected && info.resetsAt) {
      const scope = familyLimits[info.rateLimitType] ?? 'all';
      report.spent[scope] = Math.max(report.spent[scope] ?? 0, info.resetsAt * 1000);
    }
    // The newest call's report wins, so an older one can't undo a move to extra usage. Claude Code reports any 429
    // without the reset header as rejected with no resetsAt. From Anthropic that is about the request, not the account.
    // A proxy sends it too: TeamClaude's 429 once its pool is spent carries only retry-after, which Claude Code doesn't
    // pass on. So a proxy profile is held for a minute, until a newer call reports otherwise.
    if (started >= report.started) {
      const refused = rejected && !info.resetsAt && this.proxied(profile);
      Object.assign(report, { info, started, refusedUntil: refused ? Date.now() + proxyRefusalHold : 0 });
    }
    this.reports.set(key, report);
  }

  // The report for the profile's current login. Throws when the login can't be read.
  report(profile) {
    return this.reports.get(`${profile}\n${this.loginOf(profile)}`);
  }

  // When the profile can serve this model again; 0 when it can now.
  spentUntil(profile, model, now = Date.now()) {
    return spentUntil(this.report(profile), model, now);
  }

  // Profiles not in `tried` that can serve this model now, in profiles.json order. One without a readable login can't.
  usable(model, tried = new Set(), now = Date.now()) {
    const usable = [];
    for (const name of this.names) {
      if (tried.has(name)) continue;
      let report;
      try { report = this.report(name); } catch { continue; }
      if (!spentUntil(report, model, now)) usable.push({ name, extraUsage: onExtraUsage(report, now) });
    }
    return usable;
  }

  // The current profile while it has plan quota, else the first in profiles.json order that has. A profile on paid
  // extra usage is used only when none has plan quota. Undefined when no untried profile can serve the model.
  choose(model, tried, now = Date.now()) {
    const usable = this.usable(model, tried, now);
    const plan = usable.filter(profile => !profile.extraUsage);
    const pool = (plan.length ? plan : usable).map(profile => profile.name);
    const choice = pool.includes(this.current) ? this.current : pool[0];
    if (choice) this.current = choice;
    return choice;
  }

  // The earliest time a profile can serve this model again; Infinity when none reported a reset.
  nextReset(model, now = Date.now()) {
    const resets = this.names.map(name => {
      try { return this.spentUntil(name, model, now); } catch { return 0; }
    });
    return Math.min(...resets.filter(Boolean));
  }

  status(now = Date.now()) {
    const time = ms => new Date(ms).toISOString();
    return { current: this.current, profiles: Object.fromEntries(this.names.map(name => {
      let report;
      try { report = this.report(name); } catch (error) { return [name, { error: error.message }]; }
      if (!report) return [name, null];
      const spent = Object.entries({ ...report.spent, proxy_refusal: report.refusedUntil }).filter(([, until]) => until > now);
      return [name, { call_started_at: time(report.started), rate_limit_info: report.info, on_extra_usage: onExtraUsage(report, now),
        spent_until: Object.fromEntries(spent.map(([scope, until]) => [scope, time(until)])) }];
    })) };
  }
}
