// What the relayer must not lose in a restart, in one SQLite file: which phones were handed test
// dollars (so none is handed twice and a restart remembers), how many fee top-ups each phone has
// had, and the timestamps the rate limits count. It holds no chain state; the chain is asked for
// balances and nonces. Nothing here is a reading of any market.
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
  create table if not exists handouts (address text primary key, device text not null unique, ip text not null, at integer not null) strict;
  create table if not exists fees (address text not null, at integer not null) strict;
  create table if not exists hits (bucket text not null, who text not null, at integer not null) strict;
  create index if not exists hits_by_who on hits (bucket, who, at);
`;

export type Store = ReturnType<typeof openStore>;

const low = (s: string) => s.toLowerCase();

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal; pragma synchronous = full;");
  db.exec(SCHEMA);
  const q = (sql: string) => db.prepare(sql);

  return {
    close: () => db.close(),

    // ---- handouts: one address once, one device once, no more than `most` in all ----
    /**
     * Records that an address (on a device, from a network address) was handed dollars. Done in one
     * synchronous step so two requests at once cannot both be recorded: "address"/"device" if that
     * address or device was handed before, "none-left" once `most` phones were handed, else "ok".
     */
    grant(address: string, device: string, ip: string, at: number, most: number): "ok" | "address" | "device" | "none-left" {
      const a = low(address);
      if (q("select 1 from handouts where address = ?").get(a)) return "address";
      if (q("select 1 from handouts where device = ?").get(device)) return "device";
      if ((q("select count(*) as n from handouts").get() as { n: number }).n >= most) return "none-left";
      q("insert into handouts (address, device, ip, at) values (?, ?, ?, ?)").run(a, device, ip, at);
      return "ok";
    },
    /** Takes a handout record back out (a send that failed or that the chain turned back). */
    ungrant: (address: string): void => void q("delete from handouts where address = ?").run(low(address)),
    handed: (address: string): boolean => q("select 1 from handouts where address = ?").get(low(address)) !== undefined,
    handedDevice: (device: string): boolean => q("select 1 from handouts where device = ?").get(device) !== undefined,

    // ---- fee top-ups: at most `most` an address ----
    /**
     * Reserves a fee top-up for an address in one synchronous step, so two requests at once cannot
     * both slip past the count: "too-many" once `most` are already reserved, else the reservation's
     * row id, which `ungrantFee` takes back out if the send fails or the chain turns it back.
     */
    grantFee(address: string, at: number, most: number): number | "too-many" {
      const a = low(address);
      if ((q("select count(*) as n from fees where address = ?").get(a) as { n: number }).n >= most) return "too-many";
      return Number(q("insert into fees (address, at) values (?, ?)").run(a, at).lastInsertRowid);
    },
    /** Takes a fee reservation back out by its row id (a send that failed or that the chain turned back). */
    ungrantFee: (id: number): void => void q("delete from fees where rowid = ?").run(id),
    feeCount: (address: string): number => (q("select count(*) as n from fees where address = ?").get(low(address)) as { n: number }).n,

    // ---- rate limits: timestamps counted in a window ----
    noteHit: (bucket: string, who: string, at: number): void => void q("insert into hits (bucket, who, at) values (?, ?, ?)").run(bucket, who, at),
    hitCount: (bucket: string, who: string, since: number): number =>
      (q("select count(*) as n from hits where bucket = ? and who = ? and at > ?").get(bucket, who, since) as { n: number }).n,
  };
}
