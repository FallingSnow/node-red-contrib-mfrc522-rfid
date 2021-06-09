const Mfrc522 = require("../mfrc522-rpi/index");
const SoftSPI = require("../rpi-softspi/index");
const Buffer = require("buffer");
const assert = require("assert");

class RC522 {
  constructor(RED, config) {
    Object.assign(this, { RED, config });

    const spi = new SoftSPI({
      clock: 23, // pin number of SCLK
      mosi: 19, // pin number of MOSI
      miso: 21, // pin number of MISO
      client: config.CSpin || 24 // pin number of CS
    });

    this.mfrc522 = new Mfrc522(spi).setResetPin(22);

    this.on('input', this.onInput.bind(this));

    return this;
  }

  findCard() {
    mfrc522.reset();
    const { status, ...card } = this.mfrc522.findCard();
    if (!status) {
      throw new Error("Could not find card");
    }
    return card;
  }

  getUid() {
    const { data, status } = this.mfrc522.getUid();
    if (!status) {
      throw new Error("Could not get card uid");
    }
    // const uid = data.map(d => d.toString(16)).join(":");
    return data;
  }

  writeSector(uidArray, data, {
    key = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    sector = 2,
    keyA,
    keyB
  }) {
    const offset = sector * 4;

    this.mfrc522.selectCard(uidArray);

    if (!this.mfrc522.authenticate(offset, key, uidArray)) {
      this.status({
        fill: "red",
        shape: "dot",
        text: "Authentication error."
      });
      this.log("Authentication Error");
      return;
    }

    if (data.length > 48) {
      throw new Error(`You can only write 48 bytes to a sector. Tried to write ${data.length}`);
    } else if (data.length != 48) {
      data = Buffer.alloc(48, data);
    }

    this.mfrc522.writeDataToBlock(offset, data.slice(0, 15));
    this.mfrc522.writeDataToBlock(offset + 1, data.slice(16, 31));
    this.mfrc522.writeDataToBlock(offset + 2, data.slice(32, 47));

    if (keyA || keyB) {
      let features = this.mfrc522.getDataForBlock(offset + 3);

      if (keyA) {
        assert.strictEqual(keyA.length, 6);
        features = [...keyA, ...features.slice(6)];
      }
      if (keyB) {
        assert.strictEqual(keyB.length, 6);
        features = [...features.slice(0, 9), ...keyB];
      }

      // Write authentication block
      this.mfrc522.writeDataToBlock(offset + 3, features);
    }

    this.stopCrypto();

  }

  readSector(uidArray, { key = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff], sector = 2 }) {
    // Default authentication key A is [0x0, 0x0, 0x0, 0x0, 0x0, 0x0]
    // Default authentication key B is [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
    const offset = sector * 4;

    let data = "";

    this.mfrc522.selectCard(uidArray);

    if (!this.mfrc522.authenticate(offset, key, uidArray)) {
      this.status({
        fill: "red",
        shape: "dot",
        text: "Authentication error."
      });
      this.log("Authentication Error");
      return;
    }

    // Features are not read, it contains the 2 auth keys and access bits. On some cards this block always returns random data.
    // It's like reading a password, you can't.
    let [...blocks, features] = [this.mfrc522.getDataForBlock(offset), this.mfrc522.getDataForBlock(offset + 1), this.mfrc522.getDataForBlock(offset + 2), this.mfrc522.getDataForBlock(offset + 3)];

    this.stopCrypto();


    for (let block of blocks) {
      for (let byte of block) {
        data += String.fromCharCode(byte);
      }
    }

    return data;
  }

  async onInput(msg, send) {
    const timestamp = Date.now();
    const targetTime = this.lastTime + this.config.blockedFor;

    let card;
    try {
      card = this.findCard();

      let uidArray = this.getUid();
      if (uidArray === this.lastUidArray && timestamp <= targetTime) {
        throw new Error("Blocked");
      }

      // Yay! We got a card we want to work with!
      this.lastUidArray = uidArray;
      this.lastTime = timestamp;
    } catch (e) {
      // No error because if these fail then we just couldn't read the card successfully
      // or we don't want to read the same card again so soon
      return;
    }

    const uid = this.lastUidArray.map(d => d.toString(16)).join(":");
    this.log("New Card detected, CardType: " + card.bitSize);
    this.log("UID: " + uid);


    // Do we want to write or read?
    if (msg.payload.data) {
      // Write

      this.writeSector(this.lastUidArray, Buffer.from(msg.payload.data), {
        key: this.config.authenticationKey || msg.payload.authenticationKey,
        sector: this.config.sector,
        keyA: msg.payload.keyA,
        keyB: msg.payload.keyB,
      });
    } else {
      // Read

      const data = this.readSector(this.lastUidArray, {
        key: this.config.authenticationKey || msg.payload.authenticationKey,
        sector: this.config.sector
      });

      this.status({
        fill: "green",
        shape: "dot",
        text: data || uid
      });

      Object.assign(msg.payload, {
        uid,
        data,
        timestamp,
        bitSize
      });
    }

    send(msg);
  }

}

module.exports = function (RED) {
  RED.nodes.registerType("rc522", RC522.constructor);
}