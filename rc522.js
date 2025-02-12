const Mfrc522 = require("mfrc522-rpi");
const SoftSPI = require("rpi-softspi");
const Buffer = require("buffer");
const assert = require("assert");

module.exports = function (RED) {

  function rc522(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const spi = new SoftSPI({
      clock: 23, // pin number of SCLK
      mosi: 19, // pin number of MOSI
      miso: 21, // pin number of MISO
      client: config.CSpin || 24 // pin number of CS
    });
    const mfrc522 = new Mfrc522(spi).setResetPin(22);
    let blockedUntil = BigInt(0), lastUidArray = [];

    function findCard() {
      mfrc522.reset();
      const { status, ...card } = mfrc522.findCard();
      if (!status) {
        throw new Error("Could not find card");
      }
      return card;
    }

    function getUid() {
      const { data, status } = mfrc522.getUid();
      if (!status) {
        throw new Error("Could not get card uid");
      }
      // const uid = data.map(d => d.toString(16)).join(":");
      return data;
    }

    function writeSector(uidArray, data, {
      key = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
      sector = 2,
      keyA,
      keyB
    }) {
      const offset = sector * 4;

      mfrc522.selectCard(uidArray);

      if (!mfrc522.authenticate(offset, key, uidArray)) {
        node.status({
          fill: "red",
          shape: "dot",
          text: "Authentication error."
        });
        node.log("Authentication Error");
        return;
      }

      if (data.length > 48) {
        throw new Error(`You can only write 48 bytes to a sector. Tried to write ${data.length}`);
      } else if (data.length != 48) {
        data = Buffer.alloc(48, data);
      }

      mfrc522.writeDataToBlock(offset, data.slice(0, 15));
      mfrc522.writeDataToBlock(offset + 1, data.slice(16, 31));
      mfrc522.writeDataToBlock(offset + 2, data.slice(32, 47));

      if (keyA || keyB) {
        let features = mfrc522.getDataForBlock(offset + 3);

        if (keyA) {
          assert.strictEqual(keyA.length, 6);
          features = [...keyA, ...features.slice(6)];
        }
        if (keyB) {
          assert.strictEqual(keyB.length, 6);
          features = [...features.slice(0, 9), ...keyB];
        }

        // Write authentication block
        mfrc522.writeDataToBlock(offset + 3, features);
      }

      mfrc522.stopCrypto();

    }

    function readSector(uidArray, { key = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff], sector = 2 }) {
      // Default authentication key A is [0x0, 0x0, 0x0, 0x0, 0x0, 0x0]
      // Default authentication key B is [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
      const offset = sector * 4;

      let data = "";

      mfrc522.selectCard(uidArray);

      if (!mfrc522.authenticate(offset, key, uidArray)) {
        node.status({
          fill: "red",
          shape: "dot",
          text: "Authentication error."
        });
        node.log("Authentication Error");
        return;
      }

      // Features are not read, it contains the 2 auth keys and access bits. On some cards this block always returns random data.
      // It's like reading a password, you can't.
      let blocks = [mfrc522.getDataForBlock(offset), mfrc522.getDataForBlock(offset + 1), mfrc522.getDataForBlock(offset + 2)];
      // let features = mfrc522.getDataForBlock(offset + 3);

      mfrc522.stopCrypto();


      for (let block of blocks) {
        for (let byte of block) {
          data += String.fromCharCode(byte);
        }
      }

      return data;
    }

    node.on('input', function onInput(msg, send) {
      const hrtime = process.hrtime.bigint();
      node.status({});

      let card;
      try {
        card = findCard();

        let uidArray = getUid();
        if (uidArray.equals(lastUidArray) && hrtime <= blockedUntil) {
          throw new Error("Blocked");
        }

        // Yay! We got a card we want to work with!
        lastUidArray = uidArray;
        blockedUntil = hrtime + (BigInt(config.blockedFor) || 500n) * 1000000n;
      } catch (e) {
        // No error because if these fail then we just couldn't read the card successfully
        // or we don't want to read the same card again so soon
        return;
      }

      const uid = lastUidArray.map(d => d.toString(16)).join(":");
      node.log("New Card detected, CardType: " + card.bitSize);
      node.log("UID: " + uid);


      // Do we want to write or read?
      if (msg.payload?.data) {
        // Write

        writeSector(lastUidArray, Buffer.from(msg.payload.data), {
          key: config.key ? Buffer.from(config.key, "hex").toArray() : undefined,
          sector: config.sector,
          keyA: msg.payload.keyA,
          keyB: msg.payload.keyB,
        });
      } else {
        // Read

        const data = readSector(lastUidArray, {
          key: config.key ? Buffer.from(config.key, "hex").toArray() : undefined,
          sector: config.sector
        });

        node.status({
          fill: "green",
          shape: "dot",
          text: uid
        });

        msg.payload = {
          uid,
          data,
          bitSize: card.bitSize
        };
      }

      send(msg);
    });

  }

  RED.nodes.registerType("rc522", rc522);
}


// https://stackoverflow.com/questions/7837456/how-to-compare-arrays-in-javascript
// Warn if overriding existing method
if(Array.prototype.equals)
    console.warn("Overriding existing Array.prototype.equals. Possible causes: New API defines the method, there's a framework conflict or you've got double inclusions in your code.");
// attach the .equals method to Array's prototype to call it on any array
Array.prototype.equals = function (array) {
    // if the other array is a falsy value, return
    if (!array)
        return false;

    // compare lengths - can save a lot of time 
    if (this.length != array.length)
        return false;

    for (var i = 0, l=this.length; i < l; i++) {
        // Check if we have nested arrays
        if (this[i] instanceof Array && array[i] instanceof Array) {
            // recurse into the nested arrays
            if (!this[i].equals(array[i]))
                return false;       
        }           
        else if (this[i] != array[i]) { 
            // Warning - two different object instances will never be equal: {x:20} != {x:20}
            return false;   
        }           
    }       
    return true;
}
// Hide method from for-in loops
Object.defineProperty(Array.prototype, "equals", {enumerable: false});