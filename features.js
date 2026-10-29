import { randomBytes, randomUUID } from 'node:crypto';

const clean = (value, max = 500) =>
  String(value || '')
    .trim()
    .slice(0, max);
export function structuredContent(payload, me, members) {
  const extra = {};
  const types = ['poll', 'event', 'task', 'decision', 'contact', 'sticker'].filter(
    (key) => payload[key]
  );
  if (types.length > 1) throw new Error('Send one card at a time');
  if (payload.poll) {
    const p = payload.poll;
    const options = [
      ...new Set(
        (Array.isArray(p.options) ? p.options : []).map((v) => clean(v, 100)).filter(Boolean)
      ),
    ];
    if (!clean(p.question, 250) || options.length < 2 || options.length > 10)
      throw new Error('A poll needs a question and 2–10 different options');
    extra.poll = {
      question: clean(p.question, 250),
      options: options.map((text) => ({ id: randomUUID(), text, voters: [] })),
      multiple: !!p.multiple,
      closed: false,
    };
  }
  if (payload.event) {
    const e = payload.event,
      at = new Date(e.at).getTime();
    if (!clean(e.title, 150) || !Number.isFinite(at) || at <= Date.now())
      throw new Error('Choose an event title and future date');
    extra.event = {
      title: clean(e.title, 150),
      at,
      location: clean(e.location, 200),
      description: clean(e.description, 1000),
      responses: { [me]: 'going' },
    };
  }
  if (payload.task) {
    const t = payload.task,
      due = t.dueAt ? new Date(t.dueAt).getTime() : null;
    if (
      !clean(t.title, 250) ||
      (t.assignee && !members.includes(t.assignee)) ||
      (t.dueAt && !Number.isFinite(due))
    )
      throw new Error('Choose a task title, valid due date and chat member');
    extra.task = {
      title: clean(t.title, 250),
      description: clean(t.description, 1000),
      assignee: t.assignee || null,
      dueAt: due,
      priority: ['low', 'normal', 'high'].includes(t.priority) ? t.priority : 'normal',
      state: 'todo',
      sourceId: clean(t.sourceId, 100) || null,
    };
  }
  if (payload.decision) {
    if (!clean(payload.decision.title, 250)) throw new Error('Write the decision');
    extra.decision = {
      title: clean(payload.decision.title, 250),
      context: clean(payload.decision.context, 1000),
      agreedBy: [me],
    };
  }
  if (payload.contact) {
    if (
      !clean(payload.contact.name, 60) ||
      !/^\+?[\d\s()-]{7,20}$/.test(payload.contact.phone || '')
    )
      throw new Error('Enter a contact name and valid phone number');
    extra.contact = {
      name: clean(payload.contact.name, 60),
      phone: clean(payload.contact.phone, 20),
    };
  }
  if (payload.sticker) {
    const s = payload.sticker;
    if (!['✨', '🚀', '✅', '🎉', '💡', '🔥', '💜', '👍', '☕', '🙌', '🫡', '💯'].includes(s.emoji))
      throw new Error('Choose a sticker');
    extra.sticker = {
      emoji: s.emoji,
      label: clean(s.label, 30),
      color: ['violet', 'coral', 'mint', 'amber'].includes(s.color) ? s.color : 'violet',
    };
  }
  return extra;
}

export function installFeatures({
  db,
  save,
  on,
  getMe,
  prefs,
  emitTo,
  emitMessage,
  membersOf,
  canRead,
  blocked,
  syncGroups,
  syncPrefs,
  deliverMessage,
  founderPhone,
}) {
  const schedules = (me) =>
    (db.scheduled || [])
      .filter((s) => s.from === me)
      .slice(-200)
      .reverse();
  const syncSchedules = (me) => emitTo([me], 'scheduled', schedules(me));
  const message = (rid, id) => {
    const me = getMe();
    return canRead(me, rid || '')
      ? db.history[rid]?.find((m) => m.id === id && !m.deleted && !m.deletedFor?.includes(me))
      : null;
  };
  on('message_action', ({ roomId, messageId, action, optionId, response, state }, ack) => {
    const me = getMe(),
      m = message(roomId, messageId);
    if (!m) return ack?.({ ok: false, error: 'This card is unavailable' });
    if (!roomId.startsWith('group:') && blocked(me, m.from === me ? m.to : m.from))
      return ack?.({ ok: false, error: 'This contact is blocked' });
    if (action === 'vote' && m.poll && !m.poll.closed) {
      const option = m.poll.options.find((o) => o.id === optionId);
      if (!option) return ack?.({ ok: false, error: 'Option is unavailable' });
      const selected = option.voters.includes(me);
      if (!m.poll.multiple)
        m.poll.options.forEach((o) => {
          o.voters = o.voters.filter((p) => p !== me);
        });
      if (selected) option.voters = option.voters.filter((p) => p !== me);
      else option.voters = [...new Set([...option.voters, me])];
    } else if (action === 'close_poll' && m.poll && m.from === me) m.poll.closed = true;
    else if (action === 'rsvp' && m.event && ['going', 'maybe', 'declined'].includes(response))
      m.event.responses[me] = response;
    else if (action === 'task_state' && m.task && ['todo', 'doing', 'done'].includes(state)) {
      m.task.state = state;
      m.task.updatedBy = me;
      m.task.updatedAt = Date.now();
    } else if (action === 'agree' && m.decision)
      m.decision.agreedBy = m.decision.agreedBy.includes(me)
        ? m.decision.agreedBy.filter((p) => p !== me)
        : [...m.decision.agreedBy, me];
    else return ack?.({ ok: false, error: 'This action is not allowed' });
    save();
    emitMessage(m);
    ack?.({ ok: true });
  });
  on('mark_read', ({ targets }, ack) => {
    const me = getMe(),
      selected = Array.isArray(targets) ? new Set(targets.slice(0, 1000)) : null;
    for (const [rid, list] of Object.entries(db.history)) {
      if (!canRead(me, rid)) continue;
      const target = rid.startsWith('group:') ? rid : rid.split('::').find((p) => p !== me) || me;
      if (selected && !selected.has(target)) continue;
      for (const m of list)
        if (m.from !== me && !m.readBy.includes(me) && !m.deletedFor.includes(me)) {
          m.readBy.push(me);
          if (!m.deliveredTo.includes(me)) m.deliveredTo.push(me);
          emitMessage(m);
        }
    }
    save();
    ack?.({ ok: true });
  });
  on('focus_mode', ({ enabled }, ack) => {
    const me = getMe();
    prefs(me).focusUntil = enabled ? Date.now() + 30 * 60000 : 0;
    syncPrefs(me);
    ack?.({ ok: true });
  });
  on('chat_list', ({ action, id, name, chat }, ack) => {
    const me = getMe(),
      lists = (prefs(me).lists ||= []);
    if (action === 'create') {
      if (!clean(name, 40) || lists.length >= 20)
        return ack?.({ ok: false, error: 'Enter a list name (maximum 20 lists)' });
      lists.push({ id: randomUUID(), name: clean(name, 40), chats: chat ? [chat] : [] });
    } else {
      const list = lists.find((l) => l.id === id);
      if (!list) return ack?.({ ok: false, error: 'List is unavailable' });
      if (action === 'toggle' && typeof chat === 'string')
        list.chats = list.chats.includes(chat)
          ? list.chats.filter((p) => p !== chat)
          : [...list.chats, chat];
      else if (action === 'delete') prefs(me).lists = lists.filter((l) => l.id !== id);
      else return ack?.({ ok: false, error: 'Unknown list action' });
    }
    syncPrefs(me);
    ack?.({ ok: true });
  });
  on('schedule_message', ({ to, text, at }, ack) => {
    const me = getMe(),
      rid = to?.startsWith('group:') ? to : [me, to].sort().join('::'),
      when = new Date(at).getTime();
    if (
      !canRead(me, rid) ||
      !clean(text, 4000) ||
      !Number.isFinite(when) ||
      when <= Date.now() ||
      when > Date.now() + 365 * 86400000 ||
      (!to.startsWith('group:') && (!db.accounts[to] || blocked(me, to)))
    )
      return ack?.({ ok: false, error: 'Choose a chat, message and future date within one year' });
    if ((db.scheduled || []).filter((s) => s.from === me && s.state === 'pending').length >= 100)
      return ack?.({ ok: false, error: 'Maximum 100 pending messages' });
    (db.scheduled ||= []).push({
      id: randomUUID(),
      from: me,
      to,
      text: clean(text, 4000),
      at: when,
      state: 'pending',
      createdAt: Date.now(),
    });
    save();
    syncSchedules(me);
    ack?.({ ok: true });
  });
  on('cancel_scheduled', ({ id }, ack) => {
    const me = getMe(),
      s = db.scheduled?.find((s) => s.id === id && s.from === me && s.state === 'pending');
    if (!s) return ack?.({ ok: false, error: 'This message is no longer pending' });
    s.state = 'cancelled';
    save();
    syncSchedules(me);
    ack?.({ ok: true });
  });
  on('group_invite', ({ id, reset }, ack) => {
    const me = getMe(),
      g = db.groups[id];
    if (!g?.members.includes(me) || (!g.admins.includes(me) && !g.settings?.memberInvites))
      return ack?.({ ok: false, error: 'Only permitted members can create invite links' });
    if (reset && !g.admins.includes(me))
      return ack?.({ ok: false, error: 'Only admins can reset an invite link' });
    if (reset || !g.inviteToken || g.inviteExpiresAt <= Date.now()) {
      g.inviteToken = randomBytes(24).toString('hex');
      g.inviteExpiresAt = Date.now() + 7 * 86400000;
      save();
    }
    ack?.({ ok: true, token: g.inviteToken, expiresAt: g.inviteExpiresAt });
  });
  on('preview_invite', ({ token }, ack) => {
    const g = Object.values(db.groups).find(
      (g) => g.inviteToken === token && g.inviteExpiresAt > Date.now()
    );
    if (!g) return ack?.({ ok: false, error: 'This invite has expired or was reset' });
    ack?.({
      ok: true,
      group: {
        id: g.id,
        name: g.name,
        description: g.description,
        count: g.members.length,
        joined: g.members.includes(getMe()),
      },
    });
  });
  on('join_group', ({ token }, ack) => {
    const me = getMe(),
      g = Object.values(db.groups).find(
        (g) => g.inviteToken === token && g.inviteExpiresAt > Date.now()
      );
    if (!g || g.members.length >= 100 || blocked(me, g.createdBy))
      return ack?.({ ok: false, error: 'This invite is unavailable or the group is full' });
    if (!g.members.includes(me)) {
      g.members.push(me);
      (g.activity ||= []).push({
        id: randomUUID(),
        by: me,
        text: `${db.accounts[me].name} joined via invite link`,
        at: Date.now(),
      });
    }
    syncGroups();
    ack?.({ ok: true, group: { ...g, inviteToken: undefined } });
  });
  on('group_settings', ({ id, adminsOnly, memberInvites }, ack) => {
    const me = getMe(),
      g = db.groups[id];
    if (!g?.admins.includes(me))
      return ack?.({ ok: false, error: 'Only admins can change group permissions' });
    g.settings = { adminsOnly: !!adminsOnly, memberInvites: !!memberInvites };
    (g.activity ||= []).push({
      id: randomUUID(),
      by: me,
      text: `${db.accounts[me].name} changed group permissions`,
      at: Date.now(),
    });
    syncGroups();
    ack?.({ ok: true });
  });
  on('member_tag', ({ id, tag }, ack) => {
    const me = getMe(),
      g = db.groups[id];
    if (!g?.members.includes(me)) return ack?.({ ok: false, error: 'You are not a group member' });
    (g.tags ||= {})[me] = clean(tag, 30);
    syncGroups();
    ack?.({ ok: true });
  });
  on('report_chat', ({ to, reason }, ack) => {
    const me = getMe(),
      rid = to?.startsWith('group:') ? to : [me, to].sort().join('::');
    if (!canRead(me, rid) || clean(reason, 1000).length < 5)
      return ack?.({ ok: false, error: 'Describe the issue in at least 5 characters' });
    (db.reports ||= []).push({
      id: randomUUID(),
      from: me,
      chat: to,
      reason: clean(reason, 1000),
      at: Date.now(),
      state: 'open',
    });
    save();
    if (founderPhone) emitTo([founderPhone], 'reports', db.reports);
    ack?.({ ok: true });
  });
  on('resolve_report', ({ id }, ack) => {
    if (getMe() !== founderPhone)
      return ack?.({ ok: false, error: 'Only the site founder can review reports' });
    const report = db.reports?.find((r) => r.id === id);
    if (!report) return ack?.({ ok: false, error: 'Report not found' });
    report.state = 'reviewed';
    save();
    emitTo([founderPhone], 'reports', db.reports);
    ack?.({ ok: true });
  });
}

export function startScheduler({ db, save, deliverMessage, emitTo }) {
  const tick = () => {
    for (const scheduled of db.scheduled || []) {
      if (scheduled.state !== 'pending' || scheduled.at > Date.now()) continue;
      try {
        const m = deliverMessage(scheduled.from, {
          to: scheduled.to,
          text: scheduled.text,
          clientId: `scheduled:${scheduled.id}`,
        });
        scheduled.state = 'sent';
        scheduled.messageId = m.id;
      } catch (error) {
        scheduled.state = 'failed';
        scheduled.error = error.message;
      }
      save();
      emitTo(
        [scheduled.from],
        'scheduled',
        db.scheduled
          .filter((s) => s.from === scheduled.from)
          .slice(-200)
          .reverse()
      );
    }
  };
  const timer = setInterval(tick, 1000);
  timer.unref();
  tick();
}
