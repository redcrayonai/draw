// The builder's test plugin (scripts/fixtures/outside-plugin/README.md). Tests turn this
// folder into a git repository and fetch it by URL, as a plugin outside this repo.
import { table, t, SenderError, pluginEnabled, membership, type ModuleApi } from '@draw/module';

const PinboardNoteRow = t.object('PinboardNoteRow', { id: t.u64(), boardId: t.u64(), text: t.string() });

export const tables = {
  pinboardNote: table({}, {
    id: t.u64().primaryKey().autoInc(),
    workspaceId: t.u64(),
    boardId: t.u64().index('btree'),
    text: t.string(),
  }),
};

export function features(db: any, api: ModuleApi): any {
  return {
    addPinboardNote: api.reducer({ workspaceId: t.u64(), boardId: t.u64(), text: t.string() }, (ctx: any, { workspaceId, boardId, text }: any) => {
      if (!membership(ctx, workspaceId) || ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled) throw new SenderError('REJECTED: join this workspace first');
      if (!pluginEnabled(ctx, workspaceId, 'pinboard')) throw new SenderError('REJECTED: turn Pinboard on for this workspace first');
      ctx.db.pinboardNote.insert({ id: 0n, workspaceId, boardId, text });
    }),
    myPinboardNotes: db.view({ name: 'my_pinboard_notes', public: true }, t.array(PinboardNoteRow), (ctx: any) =>
      ctx.db.workspaceAccount.identity.find(ctx.sender)?.disabled ? [] : [...ctx.db.workspaceMember.member.filter(ctx.sender)].flatMap((m: any) => !pluginEnabled(ctx, m.workspaceId, 'pinboard') ? []
        : [...ctx.db.pinboardNote.iter()].filter((n: any) => n.workspaceId === m.workspaceId).map((n: any) => ({ id: n.id, boardId: n.boardId, text: n.text })))),
  };
}
