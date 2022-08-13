var bluetoothDevice;

  let svc_1802 = '00001802-0000-1000-8000-00805f9b34fb';
  let svc_1803 = '00001803-0000-1000-8000-00805f9b34fb';
  let svc_1804 = '00001804-0000-1000-8000-00805f9b34fb';

  let char_1802_3a02 = '00003a02-0000-1000-8000-00805f9b34fb';
  let char_1803_3a01 = '00003a01-0000-1000-8000-00805f9b34fb';
  let char_1804_3a03 = '00003a03-0000-1000-8000-00805f9b34fb';

  let char_2800 = '00002800-0000-1000-8000-00805f9b34fb';
  let char_2803 = '00002803-0000-1000-8000-00805f9b34fb';

  let handle_1802 = null;
  let handle_1803 = null;
  let handle_1804 = null;

function onScanButtonClick() {
  let options = {filters: []};

  // options.filters.push({optionalServices: ['00001800-0000-1000-8000-00805f9b34fb']});
  // let access = 'generic_access';

  options.filters.push({services: [svc_1802,svc_1803,svc_1804]});

  let filterName = document.querySelector('#name').value;
  if (filterName) {
    options.filters.push({name: filterName});
  }

  bluetoothDevice = null;
  log('Requesting Bluetooth Device...');
  navigator.bluetooth.requestDevice(options)
  .then(device => {
    bluetoothDevice = device;
    bluetoothDevice.addEventListener('gattserverdisconnected', onDisconnected);
    return connect();
  })
  .catch(error => {
    log('Argh! ' + error);
  });
}

function connect() {
  log('Connecting to Bluetooth Device...');
  // return bluetoothDevice.gatt.connect()
  // .then(server => {
    // log('> Bluetooth Device connected');
  // });

  bluetoothDevice.gatt.connect()
  .then(server => {
    log('Getting Service...');
    return server.getPrimaryService(svc_1802);
  })
  .then(service => {
    log('Getting Characteristic...');
    return service.getCharacteristic(char_1802_3a02);
  })
  .then(characteristic => {
     handle_1802 = characteristic;
     return bluetoothDevice.gatt.connect();
  })
  .then(server => {
    log('Getting Service...');
    return server.getPrimaryService(svc_1803);
  })
  .then(service => {
    log('Getting Characteristic...');
    return service.getCharacteristic(char_1803_3a01);
  })
  .then(characteristic => {
     handle_1803 = characteristic;
     return bluetoothDevice.gatt.connect();
  })
  .then(server => {
    log('Getting Service...');
    return server.getPrimaryService(svc_1804);
  })
  .then(service => {
    log('Getting Characteristic...');
    return service.getCharacteristic(char_1804_3a03);
  })
  .then(characteristic => {
     handle_1804 = characteristic;
     return handle_1802.readValue()
  })
  .then(value => {
      var enc = new TextDecoder("utf-8");
      log(enc.decode(value));
      document.querySelector('#deviceid').value = enc.decode(value);
      return handle_1803.readValue()
  })
  .then(value => {
      log(`Status is ${value.getUint8(0)}`);
      document.querySelector('#status').value = value.getUint8(0);
  })
}

function onDisconnectButtonClick() {
  if (!bluetoothDevice) {
    return;
  }
  log('Disconnecting from Bluetooth Device...');
  if (bluetoothDevice.gatt.connected) {
    bluetoothDevice.gatt.disconnect();
  } else {
    log('> Bluetooth Device is already disconnected');
  }
}

function onDisconnected(event) {
  // Object event.target is Bluetooth Device getting disconnected.
  log('> Bluetooth Device disconnected');
}


function onReconnectButtonClick() {
  if (!bluetoothDevice) {
    return;
  }
  if (bluetoothDevice.gatt.connected) {
    log('> Bluetooth Device is already connected');
    return;
  }
  connect()
  .catch(error => {
    log('Argh! ' + error);
  });
}

function onUpdateWifiButtonClick() {
  log("onUpdateWifiButtonClick")
  if (!bluetoothDevice) {
    log("no bluetoothDevice")
    return;
  }
  if (!(bluetoothDevice.gatt.connected)) {
    log("not connected")
    return;
  }

  let encoder = new TextEncoder('utf-8');
  let ssid = encoder.encode(document.querySelector('#wifi_ssid').value);
  let pass = encoder.encode(document.querySelector('#wifi_pass').value);
  let step = new Uint8Array([1]).buffer;
  log(step);

  log(`Writing ${ssid} and password`);
  handle_1804.writeValue(new Uint8Array([1]))
  .then(value => {
     log("3:");
     return handle_1804.writeValue(new Uint8Array([3]))
  })
  .then(value => {
     log("3: writing ssid");
     return handle_1803.writeValue(ssid)
  })
  .then(value => {
     log("2:");
     return handle_1804.writeValue(new Uint8Array([2]))
  })
  .then(value => {
     log("2: writing pass");
     return handle_1802.writeValue(pass)
  })
  .then(value => {
     log("4:");
     return handle_1804.writeValue(new Uint8Array([4]))
  })
  .then(value => {
     log("5:");
     return handle_1804.writeValue(new Uint8Array([5]))
  })
  .then(value => {
     log("Done");
  })
}

function onDetailsButtonClick() {
  log("onDetailsButtonClick")
  if (!bluetoothDevice) {
    log("no bluetoothDevice")
    return;
  }
  if (!(bluetoothDevice.gatt.connected)) {
    log("not connected")
    return;
  }

  handle_1802.readValue()
  .then(value => {
      var enc = new TextDecoder("utf-8");
      log(enc.decode(value));
  })
}

function onStatusButtonClick() {
  log("onDetailsButtonClick")
  if (!bluetoothDevice) {
    log("no bluetoothDevice")
    return;
  }
  if (!(bluetoothDevice.gatt.connected)) {
    log("not connected")
    return;
  }

  bluetoothDevice.gatt.connect()
  .then(server => {
    log('Getting Service...');
    return server.getPrimaryService(svc_1803);
  })
  .then(service => {
    log('Getting Characteristic...');
    // x=service.getCharacteristics(); // (characteristicUuid);
    // log(x);
    return service.getCharacteristic('00003a01-0000-1000-8000-00805f9b34fb');
  })
  .then(characteristic => {
     return characteristic.readValue();
  })
  .then(value => {
      // log(value.toString());
      //console.log(`Battery percentage is ${value.getUint8(0)}`);
      log(`Status is ${value.getUint8(0)}`);
      document.querySelector('#status').value = value.getUint8(0);
  })
}

function onTestButtonClick() {
  log("onDetailsButtonClick")
  if (!bluetoothDevice) {
    log("no bluetoothDevice")
    return;
  }
  if (!(bluetoothDevice.gatt.connected)) {
    log("not connected")
    return;
  }

  bluetoothDevice.gatt.connect()
  .then(server => {
    log('Getting Service...');
    return server.getPrimaryService(svc_1804);
  })
  .then(service => {
    log('Getting Characteristic...');
    // x=service.getCharacteristics(); // (characteristicUuid);
    // log(x);
    return service.getCharacteristic(char_1804_3a03);
  })
  .then(characteristic => {
     return characteristic.readValue();
  })
  .then(value => {
      var enc = new TextDecoder("utf-8");
      log(enc.decode(value));
      // log(value);
      // log(value.toString());
      //console.log(`Battery percentage is ${value.getUint8(0)}`);
      // log(`Status is ${value.getUint8(0)}`);
  })
}

function onTestSendButtonClick() {
  log("onDetailsButtonClick")
  if (!bluetoothDevice) {
    log("no bluetoothDevice")
    return;
  }
  if (!(bluetoothDevice.gatt.connected)) {
    log("not connected")
    return;
  }
  handle_1802.readValue()
  .then(value => {
      var enc = new TextDecoder("utf-8");
      log(enc.decode(value));
      // log(value);
      // log(value.toString());
      //console.log(`Battery percentage is ${value.getUint8(0)}`);
      // log(`Status is ${value.getUint8(0)}`);
  })
/*
  bluetoothDevice.gatt.connect()
  .then(server => {
    log('Getting Service...');
    return server.getPrimaryService(svc_1804);
  })
  .then(service => {
    log('Getting Characteristic...');
    // x=service.getCharacteristics(); // (characteristicUuid);
    // log(x);
    return service.getCharacteristic(char_1804_3a03);
  })
  .then(characteristic => {
    data = new Uint8Array([6]);
    // let encoder = new TextEncoder('utf-8');
    // let sendMsg = encoder.encode("hello");
    // x=myCharacteristic.writeValue(sendMsg);
    x=characteristic.writeValue(data.buffer);
    log(data);
    log(x);
  })
  */
}

  document.querySelector('#scan').addEventListener('click', function(event) {
    event.stopPropagation();
    event.preventDefault();

    if (isWebBluetoothEnabled()) {
      // ChromeSamples.clearLog();
      onScanButtonClick();
    }
  });
/*
  document.querySelector('#disconnect').addEventListener('click', function(event) {
    event.stopPropagation();
    event.preventDefault();

    if (isWebBluetoothEnabled()) {
      onDisconnectButtonClick();
    }
  });
  document.querySelector('#reconnect').addEventListener('click', function(event) {
    event.stopPropagation();
    event.preventDefault();

    if (isWebBluetoothEnabled()) {
      onReconnectButtonClick();
    }
  });
  */
  document.querySelector('#getStatus').addEventListener('click', function(event) {
    event.stopPropagation();
    event.preventDefault();

    if (isWebBluetoothEnabled()) {
      onStatusButtonClick();
    }
  });
  document.querySelector('#updatewifi').addEventListener('click', function(event) {
    event.stopPropagation();
    event.preventDefault();

    if (isWebBluetoothEnabled()) {
      onUpdateWifiButtonClick();
    }
  });
/*
  document.querySelector('#getDetails').addEventListener('click', function(event) {
    event.stopPropagation();
    event.preventDefault();

    if (isWebBluetoothEnabled()) {
      onDetailsButtonClick();
    }
  });
  document.querySelector('#getTest').addEventListener('click', function(event) {
    event.stopPropagation();
    event.preventDefault();

    if (isWebBluetoothEnabled()) {
      onTestButtonClick();
    }
  });
  document.querySelector('#getTestSend').addEventListener('click', function(event) {
    event.stopPropagation();
    event.preventDefault();

    if (isWebBluetoothEnabled()) {
      onTestSendButtonClick();
    }
  });
  */





  // log = ChromeSamples.log;
  log = console.log;

  function isWebBluetoothEnabled() {
    if (navigator.bluetooth) {
      return true;
    } else {
      // ChromeSamples.setStatus('Web Bluetooth API is not available.\n' +
      //    'Please make sure the "Experimental Web Platform features" flag is enabled.');
      return false;
    }
  }

