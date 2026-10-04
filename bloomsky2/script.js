'use strict';

// BloomSky SKY2 Wi-Fi configurator over Web Bluetooth.
//
// The SKY2 exposes three custom services with one characteristic each.
// Several characteristics serve two purposes depending on the step of the
// setup sequence, so they are named after what they carry:
//   1802/3a02  read: device ID         write: Wi-Fi password
//   1803/3a01  read: setup status      write: Wi-Fi SSID
//   1804/3a03  write: command byte (selects the next step / triggers actions)

const SVC_ID_PASS = '00001802-0000-1000-8000-00805f9b34fb';
const SVC_STATUS_SSID = '00001803-0000-1000-8000-00805f9b34fb';
const SVC_COMMAND = '00001804-0000-1000-8000-00805f9b34fb';

const CHAR_ID_PASS = '00003a02-0000-1000-8000-00805f9b34fb';
const CHAR_STATUS_SSID = '00003a01-0000-1000-8000-00805f9b34fb';
const CHAR_COMMAND = '00003a03-0000-1000-8000-00805f9b34fb';

const CMD_START_SETUP = 1;
const CMD_SELECT_PASS = 2;
const CMD_SELECT_SSID = 3;
const CMD_SAVE_CONFIG = 4;
const CMD_TEST_WIFI = 5;
const CMD_REBOOT = 7;

// Status codes observed on the device (see the notes on the page).
const STATUS_TEXT = {
  1: 'Waiting — connecting to Wi-Fi…',
  3: 'Good — connected to Wi-Fi. You can now reboot.',
  4: 'Error writing SSID/password',
  5: 'Could not connect to Wi-Fi — try again (a reboot may be needed)',
};

const POLL_INTERVAL_MS = 2000;
const POLL_FAILURES_BEFORE_WARNING = 3;

const $ = (sel) => document.querySelector(sel);

let device = null;
let chars = null; // {idPass, statusSsid, command} while connected
let pollTimer = null;
let pollGeneration = 0; // bumped on start/stop so a stale in-flight poll can't reschedule
let pollFailures = 0;
let busy = false; // a user-initiated operation is running
let expectingDisconnect = false;

// Web Bluetooth rejects a GATT operation while another one is in flight, so
// every read/write goes through this queue. That keeps the status poll from
// colliding with the Wi-Fi write sequence.
let gattQueue = Promise.resolve();
function gatt(op) {
  const result = gattQueue.then(op);
  gattQueue = result.catch(() => {});
  return result;
}

function write(characteristic, bytes) {
  // writeValue() is deprecated; fall back to it only on older browsers.
  return characteristic.writeValueWithResponse
    ? characteristic.writeValueWithResponse(bytes)
    : characteristic.writeValue(bytes);
}

function sendCommand(code) {
  return gatt(() => write(chars.command, new Uint8Array([code])));
}

// ---------------------------------------------------------------- UI helpers

function log(text) {
  console.log(text);
  const line = `${new Date().toLocaleTimeString()}  ${text}\n`;
  $('#log').textContent += line;
}

function showMessage(text, kind = 'info') {
  const el = $('#message');
  el.textContent = text;
  el.className = `msg msg-${kind}`;
  el.hidden = !text;
}

function setConnection(state, detail = '') {
  const el = $('#connection');
  const labels = {
    disconnected: 'Not connected',
    connecting: 'Connecting…',
    connected: 'Connected',
    unresponsive: 'Connected — not responding',
  };
  el.textContent = labels[state] + (detail ? ` · ${detail}` : '');
  el.dataset.state = state;
  updateButtons();
}

function isConnected() {
  return Boolean(device && device.gatt.connected && chars);
}

function updateButtons() {
  const connected = isConnected();
  $('#scan').disabled = busy;
  $('#reconnect').hidden = !device || connected;
  $('#reconnect').disabled = busy;
  for (const id of ['#updatewifi', '#reboot', '#getStatus']) {
    $(id).disabled = busy || !connected;
  }
}

function showStatus(code) {
  const text = STATUS_TEXT[code];
  $('#status').value = text ? `${code}: ${text}` : `${code}`;
}

async function runExclusive(action) {
  if (busy) return;
  busy = true;
  updateButtons();
  try {
    await action();
  } catch (error) {
    log(`Error: ${error}`);
    showMessage(`${error.message || error}`, 'error');
  } finally {
    busy = false;
    updateButtons();
  }
}

// ------------------------------------------------------------- connection

async function requestDevice() {
  const filters = [{services: [SVC_ID_PASS, SVC_STATUS_SSID, SVC_COMMAND]}];
  const name = $('#name').value.trim();
  if (name) filters.push({name});

  log('Requesting Bluetooth device…');
  const picked = await navigator.bluetooth.requestDevice({
    filters,
    optionalServices: [SVC_ID_PASS, SVC_STATUS_SSID, SVC_COMMAND],
  });
  if (picked !== device) {
    if (device) {
      device.removeEventListener('gattserverdisconnected', onDisconnected);
      if (device.gatt.connected) device.gatt.disconnect();
    }
    device = picked;
    device.addEventListener('gattserverdisconnected', onDisconnected);
  }
  log(`Selected ${device.name || device.id}`);
}

async function connect() {
  stopPolling();
  chars = null;
  setConnection('connecting');
  log('Connecting to GATT server…');
  const server = await device.gatt.connect();

  log('Getting services and characteristics…');
  const [idPass, statusSsid, command] = await Promise.all([
    server.getPrimaryService(SVC_ID_PASS).then((s) => s.getCharacteristic(CHAR_ID_PASS)),
    server.getPrimaryService(SVC_STATUS_SSID).then((s) => s.getCharacteristic(CHAR_STATUS_SSID)),
    server.getPrimaryService(SVC_COMMAND).then((s) => s.getCharacteristic(CHAR_COMMAND)),
  ]);
  chars = {idPass, statusSsid, command};

  const idValue = await gatt(() => chars.idPass.readValue());
  const deviceId = new TextDecoder('utf-8').decode(idValue);
  $('#deviceid').value = deviceId;
  log(`Device ID: ${deviceId}`);

  await readStatus();
  setConnection('connected');
  showMessage('Connected to SKY2. Status refreshes every 2 seconds.', 'ok');
  startPolling();
}

function onDisconnected() {
  stopPolling();
  chars = null;
  log('Device disconnected');
  setConnection('disconnected');
  if (expectingDisconnect) {
    expectingDisconnect = false;
    showMessage('SKY2 disconnected — it is rebooting.', 'ok');
  } else {
    showMessage('SKY2 disconnected. Use "Reconnect" to connect again.', 'error');
  }
}

// ---------------------------------------------------------------- status

async function readStatus() {
  const value = await gatt(() => chars.statusSsid.readValue());
  const code = value.getUint8(0);
  showStatus(code);
  return code;
}

function startPolling() {
  stopPolling();
  pollFailures = 0;
  const generation = pollGeneration;
  pollTimer = setTimeout(() => poll(generation), POLL_INTERVAL_MS);
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
  pollGeneration++;
}

async function poll(generation) {
  if (!isConnected()) return;
  try {
    const code = await readStatus();
    if (generation !== pollGeneration) return;
    pollFailures = 0;
    setConnection('connected', `last update ${new Date().toLocaleTimeString()}`);
    if (code === 3) showMessage(STATUS_TEXT[3], 'ok');
    else if (code === 4 || code === 5) showMessage(STATUS_TEXT[code], 'error');
  } catch (error) {
    pollFailures++;
    log(`Status read failed (${pollFailures}): ${error}`);
    if (generation === pollGeneration && pollFailures >= POLL_FAILURES_BEFORE_WARNING &&
        isConnected()) {
      setConnection('unresponsive');
    }
  }
  // Schedule the next poll only after this one finished, so reads never pile up.
  if (isConnected() && generation === pollGeneration) {
    pollTimer = setTimeout(() => poll(generation), POLL_INTERVAL_MS);
  }
}

// --------------------------------------------------------------- actions

async function onScanClick() {
  showMessage('');
  await requestDevice();
  await connect();
}

async function onReconnectClick() {
  if (!device) return;
  showMessage('');
  await connect();
}

async function onUpdateWifiClick() {
  if (!isConnected()) throw new Error('SKY2 is not connected.');

  const ssidText = $('#wifi_ssid').value;
  const passText = $('#wifi_pass').value;
  const encoder = new TextEncoder();
  const ssid = encoder.encode(ssidText);
  const pass = encoder.encode(passText);

  if (!ssidText || !passText) {
    throw new Error('Please fill out both the Wi-Fi SSID and the Wi-Fi password.');
  }
  if (ssid.length > 32) {
    throw new Error(`The SSID is ${ssid.length} bytes long; Wi-Fi allows at most 32.`);
  }
  if (pass.length > 64) {
    throw new Error(`The password is ${pass.length} bytes long; Wi-Fi allows at most 64.`);
  }
  if (pass.length < 8 &&
      !confirm('WPA passwords are at least 8 characters. Send this shorter password anyway?')) {
    return;
  }

  showMessage('Sending Wi-Fi settings…');
  log(`Writing SSID "${ssidText}" and password`);
  // The order of these steps is what the device expects; do not reorder.
  log('Command 1: start setup');
  await sendCommand(CMD_START_SETUP);
  log('Command 3: select SSID');
  await sendCommand(CMD_SELECT_SSID);
  log('Writing SSID');
  await gatt(() => write(chars.statusSsid, ssid));
  log('Command 2: select password');
  await sendCommand(CMD_SELECT_PASS);
  log('Writing password');
  await gatt(() => write(chars.idPass, pass));
  log('Command 4: save Wi-Fi config');
  await sendCommand(CMD_SAVE_CONFIG);
  log('Command 5: start Wi-Fi connection test');
  await sendCommand(CMD_TEST_WIFI);
  log('Wi-Fi settings sent');
  showMessage('Wi-Fi settings sent. Watching the status — this can take up to 30 seconds.');
}

async function onRebootClick() {
  if (!isConnected()) throw new Error('SKY2 is not connected.');
  log('Command 7: reboot');
  expectingDisconnect = true;
  try {
    await sendCommand(CMD_REBOOT);
  } catch (error) {
    // The device may drop the link before acknowledging the write.
    if (isConnected()) {
      expectingDisconnect = false;
      throw error;
    }
  }
  showMessage('Reboot command sent.', 'ok');
}

async function onStatusClick() {
  if (!isConnected()) throw new Error('SKY2 is not connected.');
  await readStatus();
}

// ------------------------------------------------------------------ setup

function bind(selector, handler) {
  $(selector).addEventListener('click', (event) => {
    event.preventDefault();
    runExclusive(handler);
  });
}

$('#show_pass').addEventListener('change', (event) => {
  $('#wifi_pass').type = event.target.checked ? 'text' : 'password';
});

if (navigator.bluetooth) {
  bind('#scan', onScanClick);
  bind('#reconnect', onReconnectClick);
  bind('#updatewifi', onUpdateWifiClick);
  bind('#reboot', onRebootClick);
  bind('#getStatus', onStatusClick);
  setConnection('disconnected');
} else {
  setConnection('disconnected');
  $('#scan').disabled = true;
  showMessage(
    window.isSecureContext
      ? 'This browser does not support Web Bluetooth. Please use Chrome or Edge on a desktop or Android device.'
      : 'Web Bluetooth only works on pages served over HTTPS.',
    'error');
}
