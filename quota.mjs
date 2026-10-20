// Each profile's subscription quota, as Claude Code reports it in a rate_limit_event on every call, and the profile a
// call without x-local-profile uses. Those calls stay on one profile until it is spent: a prompt cache belongs to one
// account, so a conversation that moves writes its prefix again on the next one.

// Weekly caps that cover one model family. Any other rejection spends the whole profile.
const familyLimits = { seven_day_opus: 'opus', seven_day_sonnet: 'sonnet' };
const family = model => ['opus', 'sonnet'].find(name => model.includes(name)) ?? 'other';

export class ProfileQuota {
  reports = new Map(); // Profile -> the login it ran on, its last rate_limit_info, and each spent scope's reset.

  constructor(names, loginOf) {
    this.names = names;
    this.loginOf = loginOf;
    this.current = names[0];
  }

  // rate_limit_info from a call that ran on this profile, login and model.
  record(profile, login, model, info, now = Date.now()) {
    let report = this.reports.get(profile);
    if (report?.login !== login) report = { login, spent: {} };
    Object.assign(report, { info, at: now });
    // Claude Code's own rule: rejected without extra usage refuses calls until resetsAt (seconds).
    if (info.status === 'rejected' && !info.isUsingOverage) report.spent[familyLimits[info.rateLimitType] ?? 'all'] = info.resetsAt * 1000;
    else {
      delete report.spent.all;
      delete report.spent[family(model)];
    }
    this.reports.set(profile, report);
  }

  // The report for the profile's current login: a /login to another account starts over.
  report(profile) {
    const report = this.reports.get(profile);
    if (!report) return;
    try { return report.login === this.loginOf(profile) ? report : undefined; }
    catch { return undefined; }
  }

  // When the profile can serve this model again; 0 when it can now.
  spentUntil(profile, model, now = Date.now()) {
    const spent = this.report(profile)?.spent ?? {};
    const until = Math.max(spent.all ?? 0, spent[family(model)] ?? 0);
    return until > now ? until : 0;
  }

  // The current profile while it has plan quota, else the first in profiles.json order that has. A profile serving on
  // paid extra usage is used only when none has plan quota. Undefined when every untried profile is spent.
  choose(model, tried, now = Date.now()) {
    const usable = this.names.filter(name => !tried.has(name) && !this.spentUntil(name, model, now));
    const plan = usable.filter(name => !this.report(name)?.info.isUsingOverage);
    const pool = plan.length ? plan : usable;
    const choice = pool.includes(this.current) ? this.current : pool[0];
    if (choice) this.current = choice;
    return choice;
  }

  // The earliest time a profile can serve this model again; Infinity when none reported a reset.
  nextReset(model, now = Date.now()) {
    return Math.min(...this.names.map(name => this.spentUntil(name, model, now)).filter(Boolean));
  }

  status(now = Date.now()) {
    const time = ms => new Date(ms).toISOString();
    return { current: this.current, profiles: Object.fromEntries(this.names.map(name => {
      const report = this.report(name);
      if (!report) return [name, null];
      const spent = Object.entries(report.spent).filter(([, until]) => until > now);
      return [name, { reported_at: time(report.at), rate_limit_info: report.info,
        spent_until: Object.fromEntries(spent.map(([scope, until]) => [scope, time(until)])) }];
    })) };
  }
}
