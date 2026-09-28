/// <reference path="./anime-torrent-provider.d.ts" />
/// <reference path="./core.d.ts" />

// Max releases expanded into torrents on a manual search.
const MAX_RELEASES = 12;
// Max title variants tried on a smart search.
const MAX_QUERIES = 5;

const SEARCH_INCLUDE = "id,alias,name,mal,year,episodes_total";
const TORRENT_INCLUDE = [
  "id",
  "hash",
  "size",
  "label",
  "magnet",
  "seeders",
  "leechers",
  "completed_times",
  "created_at",
  "description",
  "is_hardsub",
  "quality",
  "codec",
  "type"
].join(",");

interface EpisodeRange {
  from: number;
  to: number;
  known: boolean;
}

class Provider {
  private api = "https://aniliberty.top/api/v1";
  private headers = {
    "accept": "application/json",
    "X-CSRF-TOKEN": "seanime"
  };

  async getSettings(): Promise<AnimeProviderSettings> {
    return {
      type: "main",
      canSmartSearch: true,
      smartSearchFilters: ["batch", "episodeNumber", "resolution", "query"],
      supportsAdult: true
    };
  }

  async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
    try {
      const queries = opts.query ? [opts.query] : this.buildQueries(opts.media, "");
      const releases = await this.searchReleases(queries);
      if (releases.length === 0) return [];

      // Manual search keeps every release, but the one matching the entry's
      // MAL ID goes first so the right season doesn't get buried.
      const malId = opts.media ? opts.media.idMal : undefined;
      const ordered = releases.slice();
      ordered.sort((a, b) => this.malRank(a, malId) - this.malRank(b, malId));

      const torrents = await this.collectTorrents(ordered.slice(0, MAX_RELEASES), malId);
      return this.sortTorrents(torrents);
    } catch (e) {
      console.error("[AniLiberty] search:", e);
      return [];
    }
  }

  async smartSearch(opts: AnimeSmartSearchOptions): Promise<AnimeTorrent[]> {
    try {
      const media = opts.media;
      const queries = this.buildQueries(media, opts.query);
      const releases = await this.searchReleases(queries);
      if (releases.length === 0) return [];

      const picked = this.pickReleases(releases, media);
      if (picked.releases.length === 0) return [];

      const malId = picked.confirmed && media ? media.idMal : undefined;
      const torrents = await this.collectTorrents(picked.releases, malId);
      return this.sortTorrents(this.applyFilters(torrents, opts));
    } catch (e) {
      console.error("[AniLiberty] smartSearch:", e);
      return [];
    }
  }

  async getLatest(): Promise<AnimeTorrent[]> {
    try {
      const releases = await this.getJson(
        `${this.api}/anime/releases/latest?limit=8&include=${SEARCH_INCLUDE}`
      );
      if (!Array.isArray(releases)) return [];
      return this.sortTorrents(await this.collectTorrents(releases, undefined));
    } catch (e) {
      console.error("[AniLiberty] getLatest:", e);
      return [];
    }
  }

  async getTorrentInfoHash(torrent: AnimeTorrent): Promise<string> {
    return torrent.infoHash || "";
  }

  async getTorrentMagnetLink(t: AnimeTorrent): Promise<string> {
    return t.magnetLink || "";
  }

  // -------------------------
  // Release matching
  // -------------------------

  // Title variants, most reliable first. AniLiberty's search matches romaji
  // and Russian titles far better than English ones ("The Apothecary Diaries"
  // finds nothing, "Kusuriya no Hitorigoto" does), so one query isn't enough.
  private buildQueries(media: Media | undefined, query: string): string[] {
    const out: string[] = [];
    const push = (s: string | undefined) => {
      if (!s) return;
      const trimmed = s.trim();
      const key = this.normalize(trimmed);
      if (!key) return;
      for (const existing of out) {
        if (this.normalize(existing) === key) return;
      }
      out.push(trimmed);
    };

    push(query);
    if (media) {
      push(media.romajiTitle);
      push(media.englishTitle);
      push(this.baseTitle(media.romajiTitle));
      push(this.baseTitle(media.englishTitle));
      const syn = media.synonyms || [];
      for (let i = 0; i < syn.length && i < 2; i++) push(syn[i]);
    }

    return out.slice(0, MAX_QUERIES);
  }

  // "Dr. Stone: Science Future Part 3" -> "Dr. Stone".
  // A broad query finds the franchise; the exact season is then picked by MAL ID.
  private baseTitle(title: string | undefined): string {
    if (!title) return "";
    let s = title;
    s = s.replace(/\s*[:\-–—]\s*(season|part|cour)\s*\d+.*$/i, "");
    s = s.replace(/\s+(season|part|cour)\s*\d+.*$/i, "");
    s = s.replace(/\s+\d+(st|nd|rd|th)\s+season.*$/i, "");
    s = s.replace(/\s*:.*$/, "");
    s = s.trim();
    return this.normalize(s) === this.normalize(title) ? "" : s;
  }

  private async searchReleases(queries: string[]): Promise<any[]> {
    const responses = await Promise.all(
      queries.map(q =>
        this.getJson(
          `${this.api}/app/search/releases` +
          `?query=${encodeURIComponent(q)}` +
          `&include=${SEARCH_INCLUDE}`
        )
      )
    );

    const seen: { [id: number]: boolean } = {};
    const out: any[] = [];
    for (const list of responses) {
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        if (!r || typeof r.id !== "number" || seen[r.id]) continue;
        seen[r.id] = true;
        out.push(r);
      }
    }
    return out;
  }

  private pickReleases(
    releases: any[],
    media: Media | undefined
  ): { releases: any[]; confirmed: boolean } {
    // Exact match by MAL ID is what separates seasons of the same show,
    // which a text search lumps together.
    if (media && media.idMal) {
      const exact = releases.filter(r => r.mal && r.mal.id === media.idMal);
      if (exact.length > 0) return { releases: exact, confirmed: true };
    }

    // Fallback for releases without a MAL ID: compare title, year and episode count.
    const scored: { r: any; s: number }[] = [];
    for (const r of releases) {
      const s = this.score(r, media);
      if (s > 0) scored.push({ r, s });
    }
    scored.sort((a, b) => b.s - a.s);
    return { releases: scored.slice(0, 3).map(x => x.r), confirmed: false };
  }

  private score(release: any, media: Media | undefined): number {
    if (!media) return 0;

    const candidates: string[] = [];
    if (release.name) {
      if (release.name.english) candidates.push(release.name.english);
      if (release.name.main) candidates.push(release.name.main);
      if (release.name.alternative) candidates.push(release.name.alternative);
    }

    const targets: string[] = [];
    if (media.romajiTitle) targets.push(media.romajiTitle);
    if (media.englishTitle) targets.push(media.englishTitle);
    for (const s of media.synonyms || []) targets.push(s);

    let best = 0;
    for (const c of candidates) {
      const nc = this.normalize(c);
      if (!nc) continue;
      for (const t of targets) {
        const nt = this.normalize(t);
        if (!nt) continue;
        if (nc === nt) best = Math.max(best, 100);
        else if (nc.indexOf(nt) === 0 || nt.indexOf(nc) === 0) best = Math.max(best, 60);
        else if (nc.indexOf(nt) >= 0 || nt.indexOf(nc) >= 0) best = Math.max(best, 40);
      }
    }
    if (best === 0) return 0;

    if (media.startDate && release.year === media.startDate.year) best += 20;
    if (media.episodeCount && release.episodes_total === media.episodeCount) best += 15;
    return best;
  }

  private malRank(release: any, malId: number | undefined): number {
    if (!malId) return 1;
    return release.mal && release.mal.id === malId ? 0 : 1;
  }

  // -------------------------
  // Torrents
  // -------------------------

  private async collectTorrents(
    releases: any[],
    confirmedMalId: number | undefined
  ): Promise<AnimeTorrent[]> {
    const lists = await Promise.all(
      releases.map(async (r) => {
        const data = await this.getJson(
          `${this.api}/anime/torrents/release/${r.id}?include=${TORRENT_INCLUDE}`
        );
        if (!Array.isArray(data)) return [] as AnimeTorrent[];

        const confirmed = !!(confirmedMalId && r.mal && r.mal.id === confirmedMalId);
        const bestId = this.bestTorrentId(data);

        const mapped: AnimeTorrent[] = [];
        for (const t of data) {
          const at = this.toAnimeTorrent(t, r, confirmed, t.id === bestId);
          if (at) mapped.push(at);
        }
        return mapped;
      })
    );

    // The same torrent can come from several releases.
    const seen: { [key: string]: boolean } = {};
    const out: AnimeTorrent[] = [];
    for (const list of lists) {
      for (const t of list) {
        const key = (t.infoHash || t.magnetLink || t.name).toLowerCase();
        if (seen[key]) continue;
        seen[key] = true;
        out.push(t);
      }
    }
    return out;
  }

  private bestTorrentId(torrents: any[]): number {
    let bestId = -1;
    let bestScore = -1;
    for (const t of torrents) {
      const res = this.resolutionValue(t.quality ? t.quality.description : "");
      const score = res * 1000 + (t.seeders || 0);
      if (score > bestScore) {
        bestScore = score;
        bestId = t.id;
      }
    }
    return bestId;
  }

  private toAnimeTorrent(
    t: any,
    release: any,
    confirmed: boolean,
    isBest: boolean
  ): AnimeTorrent | null {
    if (!t.magnet && !t.hash) return null;

    const title =
      (release.name && (release.name.english || release.name.main)) ||
      t.label ||
      "?";
    const quality = (t.quality && t.quality.description) || "";
    const codec = (t.codec && t.codec.description) || "";
    const kind = (t.type && t.type.value) || "";
    const desc = (t.description || "").trim();

    const range = this.parseRange(desc, release.episodes_total);
    // Single-episode releases (movies, OVAs) come with a description like
    // "Фильм" — the range can't be parsed, but it isn't a batch either.
    const single = release.episodes_total === 1;
    const isBatch = single ? false : !range.known || range.to > range.from;

    const tags: string[] = [];
    if (desc) tags.push(desc);
    const specs = [kind, quality, codec].filter(x => !!x).join(" ");
    if (specs) tags.push(specs);
    if (t.is_hardsub) tags.push("hardsub");

    const size = t.size || 0;

    return {
      name: tags.length > 0 ? `${title} [${tags.join("][")}]` : title,
      date: t.created_at || "",
      size,
      formattedSize: this.bytesToHuman(size),
      seeders: typeof t.seeders === "number" ? t.seeders : -1,
      leechers: typeof t.leechers === "number" ? t.leechers : -1,
      downloadCount: t.completed_times || 0,
      link: release.alias
        ? `https://anilibria.top/anime/releases/release/${release.alias}`
        : "",
      downloadUrl: `${this.api}/anime/torrents/${t.id}/file`,
      magnetLink: t.magnet || "",
      infoHash: t.hash || "",
      resolution: quality,
      releaseGroup: "AniLiberty",
      isBatch,
      episodeNumber: isBatch ? -1 : single ? 1 : range.from,
      isBestRelease: isBest,
      confirmed
    };
  }

  // -------------------------
  // Filters
  // -------------------------

  // Resolution and batch filters fall back to the unfiltered list when nothing
  // matches, so the user sees something rather than an empty result.
  private applyFilters(torrents: AnimeTorrent[], opts: AnimeSmartSearchOptions): AnimeTorrent[] {
    let out = torrents;

    if (opts.resolution) {
      const want = this.resolutionValue(opts.resolution);
      if (want > 0) {
        const filtered = out.filter(t => this.resolutionValue(t.resolution || "") === want);
        if (filtered.length > 0) out = filtered;
      }
    }

    if (opts.batch) {
      const filtered = out.filter(t => t.isBatch === true);
      if (filtered.length > 0) out = filtered;
    }

    // AniLiberty often splits a season into several torrents (1-13 / 14-24).
    // No fallback here: on an ongoing show the torrent can lag behind the site
    // (episode 12 is out, the torrent is still 1-11), and streaming a torrent
    // without the episode fails. An empty result makes Seanime retry later.
    if (opts.episodeNumber && opts.episodeNumber > 0) {
      const ep = opts.episodeNumber;
      out = out.filter(t => this.coversEpisode(t, ep));
    }

    return out;
  }

  // The episode range is the first tag in the name; parse it back instead of
  // carrying an extra field through AnimeTorrent.
  private coversEpisode(t: AnimeTorrent, ep: number): boolean {
    const m = t.name.match(/\[(\d{1,4})\s*[-–—~]\s*(\d{1,4})\]/);
    if (m) {
      return ep >= parseInt(m[1], 10) && ep <= parseInt(m[2], 10);
    }
    if (t.episodeNumber && t.episodeNumber > 0) return t.episodeNumber === ep;
    // Unknown range (movie, special, odd description) — don't hide it.
    return true;
  }

  // -------------------------
  // Helpers
  // -------------------------

  private parseRange(desc: string, total: number | undefined): EpisodeRange {
    const d = (desc || "").trim();

    let m = d.match(/(\d{1,4})\s*[-–—~]\s*(\d{1,4})/);
    if (m) {
      const from = parseInt(m[1], 10);
      const to = parseInt(m[2], 10);
      if (to >= from) return { from, to, known: true };
    }

    m = d.match(/^(\d{1,4})$/);
    if (m) {
      const n = parseInt(m[1], 10);
      return { from: n, to: n, known: true };
    }

    return { from: 1, to: total && total > 0 ? total : 9999, known: false };
  }

  private resolutionValue(res: string): number {
    if (!res) return 0;
    const m = res.match(/(\d{3,4})/);
    return m ? parseInt(m[1], 10) : 0;
  }

  private normalize(s: string | undefined): string {
    if (!s) return "";
    return s
      .toLowerCase()
      .replace(/[^a-zа-яё0-9]+/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private sortTorrents(torrents: AnimeTorrent[]): AnimeTorrent[] {
    const out = torrents.slice();
    out.sort((a, b) => {
      if (a.confirmed !== b.confirmed) return a.confirmed ? -1 : 1;
      return (b.seeders || 0) - (a.seeders || 0);
    });
    return out;
  }

  private bytesToHuman(bytes: number): string {
    if (!bytes) return "";
    const k = 1024;
    const sizes = ["B", "KiB", "MiB", "GiB", "TiB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return (bytes / Math.pow(k, i)).toFixed(2) + " " + sizes[i];
  }

  private async getJson(url: string): Promise<any> {
    try {
      const res = await fetch(url, { headers: this.headers });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }
}
