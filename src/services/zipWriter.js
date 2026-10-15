// A small streaming ZIP writer (no dependencies): each entry is deflated in memory (node:zlib), then written as a
// local header plus data; the central directory follows at the end. Plain ZIP (no ZIP64), so keep the archive and
// every entry under 4 GB and 65,535 entries; standard tools (Explorer, macOS Archive Utility, unzip, tar) read it.
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE) of a buffer. */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time (local time, 2-second resolution; years 1980-2107). */
function dosDateTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

const LIMIT = 0xffffffff;

export class ZipWriter {
  /** @param {import("node:stream").Writable} output - e.g. an Express response */
  constructor(output) {
    this.output = output;
    this.offset = 0;
    this.entries = [];
    this.names = new Set();
  }

  async #write(buffer) {
    this.offset += buffer.length;
    if (this.offset > LIMIT) throw new Error("The archive is larger than 4 GB.");
    if (!this.output.write(buffer)) await new Promise((resolve, reject) => {
      const onDrain = () => { cleanup(); resolve(); };
      const onError = error => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new Error("The download was cancelled.")); };
      const cleanup = () => { this.output.off("drain", onDrain); this.output.off("error", onError); this.output.off("close", onClose); };
      this.output.on("drain", onDrain);
      this.output.on("error", onError);
      this.output.on("close", onClose);
    });
  }

  /**
   * Adds one file.
   * @param {string} name - path inside the archive, forward slashes (backslashes are converted)
   * @param {Buffer | string} content
   * @param {{ mtime?: Date, executable?: boolean }} [options]
   */
  async addFile(name, content, { mtime = new Date(), executable = false } = {}) {
    const path = name.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path || path.split("/").some(part => part === ".." || part === "")) throw new Error(`Invalid archive path: ${name}`);
    if (this.names.has(path)) throw new Error(`Duplicate archive path: ${path}`);
    this.names.add(path);
    if (this.entries.length >= 0xffff) throw new Error("Too many files for a ZIP archive.");

    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    if (data.length > LIMIT) throw new Error(`${path} is larger than 4 GB.`);
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const stored = deflated.length >= data.length; // tiny or already-compressed files: store as is
    const body = stored ? data : deflated;
    const nameBytes = Buffer.from(path, "utf8");
    const { time, date } = dosDateTime(mtime);
    const crc = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header
    header.writeUInt16LE(20, 4); // version needed: 2.0
    header.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    header.writeUInt16LE(stored ? 0 : 8, 8); // method: store / deflate
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28); // extra length

    this.entries.push({ nameBytes, crc, compressed: body.length, size: data.length, method: stored ? 0 : 8, time, date, offset: this.offset, executable });
    await this.#write(header);
    await this.#write(nameBytes);
    await this.#write(body);
  }

  /** Writes the central directory and ends the output. */
  async finish() {
    const start = this.offset;
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0); // central directory header
      header.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0 (so the permission bits below apply)
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressed, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.nameBytes.length, 28);
      header.writeUInt16LE(0, 30); // extra
      header.writeUInt16LE(0, 32); // comment
      header.writeUInt16LE(0, 34); // disk
      header.writeUInt16LE(0, 36); // internal attributes
      header.writeUInt32LE(((entry.executable ? 0o100755 : 0o100644) << 16) >>> 0, 38); // regular file, rw-r--r-- / rwxr-xr-x
      header.writeUInt32LE(entry.offset, 42);
      await this.#write(header);
      await this.#write(entry.nameBytes);
    }
    const size = this.offset - start;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); // end of central directory
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(start, 16);
    end.writeUInt16LE(0, 20);
    await this.#write(end);
    await new Promise(resolve => this.output.end(resolve));
  }
}
