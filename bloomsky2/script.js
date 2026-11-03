'use strict';

const SCRIPT_VERSION = '2026-11-03.2'; // Keep in step with index.html.

const SVC_1802 = '00001802-0000-1000-8000-00805f9b34fb';
const SVC_1803 = '00001803-0000-1000-8000-00805f9b34fb';
const SVC_1804 = '00001804-0000-1000-8000-00805f9b34fb';

const CHAR_DEVICE_ID_OR_PASS = '00003a02-0000-1000-8000-00805f9b34fb'; // in 1802: read = device ID, write = password
const CHAR_STATUS_OR_SSID = '00003a01-0000-1000-8000-00805f9b34fb'; // in 1803: read = status, write = SSID
const CHAR_COMMAND = '00003a03-0000-1000-8000-00805f9b34fb'; // in 1804: selects what the next write means

const STATUS_TIMEOUT_MS = 30000; // A SKY2 still on "wait" after 30s has gone wrong.
const STATUS_POLL_MS = 2000;
const STATUS_MONITOR_MS = 5000; // Background check while connected and idle.
const REBOOT_DISCONNECT_WAIT_MS = 5000;
// A retry can read the previous attempt's result before the device overwrites
// it, so a final status matching the one from before the update isn't trusted yet.
const STALE_STATUS_GRACE_MS = 10000;

const STATUS_TEXT = {
  1: 'Wait',
  3: 'Good: connected to Wi-Fi',
  4: 'Not good: could not write the SSID/password',
  5: 'Not good: could not connect to Wi-Fi',
};

const FINAL_RESULTS = {
  3: {
    kind: 'ok',
    text: 'Success: your SKY2 is on Wi-Fi and reaching the gateway. Click Reboot to finish. ' +
          'Changing these settings again will mean putting it back in config mode.',
  },
  4: {
    kind: 'bad',
    text: 'The SKY2 could not save the SSID and password. Check them and try again.',
  },
  5: {
    kind: 'bad',
    text: 'The SKY2 could not connect to Wi-Fi. Check the SSID and password and try again. ' +
          'If it fails again, click Reboot, put it back in config mode, and start over.',
  },
};

const $ = (selector) => document.querySelector(selector);

let device = null;
let deviceIdOrPass = null;
let statusOrSsid = null;
let command = null;

let updating = false;
let rebooting = false;
let disconnecting = false;
let statusMonitor = null;
let monitorReadPending = false;
let gattQueue = Promise.resolve();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isConnected = () => Boolean(device && device.gatt.connected);

/* Browsers reject a GATT operation while another is in flight, so the background
   status check and the user's actions have to take turns. */
function queueGatt(operation) {
  const result = gattQueue.then(operation);
  gattQueue = result.catch(() => {});
  return result;
}

function describeStatus(code) {
  if (code === null) return 'No value';
  return `${code}: ${STATUS_TEXT[code] || 'Unknown'}`;
}

function setMessage(element, text, kind) {
  element.textContent = text || '';
  element.className = 'message' + (kind ? ` ${kind}` : '');
  element.hidden = !text;
}

const setConnectMessage = (text, kind) => setMessage($('#connectMessage'), text, kind);
const setResult = (text, kind) => {
  setMessage($('#result'), text, kind);
  if (text) $('#result').scrollIntoView({ block: 'nearest' });
};

function setControlsDisabled(disabled) {
  ['#wifi_ssid', '#wifi_pass', '#updatewifi', '#reboot', '#disconnect', '#getStatus'].forEach((selector) => {
    $(selector).disabled = disabled;
  });
}

function lockWifiForm() {
  ['#wifi_ssid', '#wifi_pass', '#updatewifi'].forEach((selector) => {
    $(selector).disabled = true;
  });
}

/* ---------- Debug log ----------
   Shown on the page so people can copy it into a bug report. Never add the
   Wi-Fi SSID or password, or the device ID, to this log. */

const DEBUG_MAX_LINES = 500;
const debugLines = [];
let failedStep = null;
let lastStatusError = null;

function debug(text) {
  const time = new Date().toISOString().slice(11, 23);
  debugLines.push(`${time} ${text}`);
  if (debugLines.length > DEBUG_MAX_LINES) debugLines.shift();
  const log = $('#debugLog');
  log.textContent = debugLines.join('\n');
  log.scrollTop = log.scrollHeight;
  console.log(text);
}

const describeError = (error) => `${error.name}: ${error.message}`;
const withoutFinalPeriod = (text) => text.replace(/\.$/, '');

/* Runs fn immediately, so requestDevice stays inside the user's click. */
async function debugStep(label, fn) {
  const startedAt = performance.now();
  const elapsed = () => `${Math.round(performance.now() - startedAt)} ms`;
  debug(`${label}...`);
  try {
    const result = await fn();
    debug(`${label}: OK (${elapsed()})`);
    return result;
  } catch (error) {
    failedStep = label;
    debug(`${label}: FAILED after ${elapsed()}: ${describeError(error)}`);
    throw error;
  }
}

function describeProperties(characteristic) {
  const properties = characteristic.properties || {};
  const names = ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate',
    'broadcast', 'authenticatedSignedWrites', 'reliableWrite', 'writableAuxiliaries'];
  return names.filter((name) => properties[name]).join(', ') || 'none reported';
}

async function logEnvironment() {
  debug(`Page ${$('#versions').dataset.pageVersion}, script ${SCRIPT_VERSION}. Times are UTC.`);
  debug(`User agent: ${navigator.userAgent}`);
  debug(`Secure context: ${window.isSecureContext}. Web Bluetooth API: ${Boolean(navigator.bluetooth)}.`);
  if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
    try {
      // The user agent string can't tell Windows 10 from 11, but platformVersion can (13+ is 11).
      const data = await navigator.userAgentData.getHighEntropyValues(['platformVersion', 'architecture', 'fullVersionList']);
      const browsers = (data.fullVersionList || []).map((b) => `${b.brand} ${b.version}`).join(', ');
      debug(`Platform: ${data.platform} ${data.platformVersion} (${data.architecture}). Browsers: ${browsers}.`);
    } catch (error) {
      debug(`Could not read platform details: ${describeError(error)}`);
    }
  }
}

async function copyDebugLog() {
  const button = $('#debugCopy');
  try {
    await navigator.clipboard.writeText(debugLines.join('\n'));
    button.textContent = 'Copied';
  } catch (error) {
    // Clipboard access can be refused, so select the text for a manual copy.
    window.getSelection().selectAllChildren($('#debugLog'));
    button.textContent = 'Press Ctrl+C or Cmd+C to copy';
  }
  setTimeout(() => { button.textContent = 'Copy log'; }, 3000);
}

/* ---------- Versions ---------- */

function showVersions() {
  const versions = $('#versions');
  const pageVersion = versions.dataset.pageVersion;
  const mismatch = pageVersion === SCRIPT_VERSION ? '' : ' (versions differ, please reload this page)';
  versions.textContent = `Page ${pageVersion} · Script ${SCRIPT_VERSION}${mismatch}`;
}

/* ---------- Bluetooth support ---------- */

function checkBluetoothSupport() {
  if (!navigator.bluetooth) {
    const reason = window.isSecureContext
      ? 'This browser does not support Web Bluetooth, which this page needs. Open it in Chrome or Edge on a computer or Android device. Safari and Firefox will not work.'
      : 'Web Bluetooth only works on secure pages. Open this page over https://.';
    setMessage($('#support'), reason, 'bad');
    $('#setup').hidden = true;
    return;
  }

  if (!navigator.bluetooth.getAvailability) return;

  const showAvailability = (available) => {
    setMessage(
      $('#support'),
      available ? '' : 'No Bluetooth adapter is available. Turn Bluetooth on and allow your browser to use it.',
      available ? null : 'warn'
    );
  };
  navigator.bluetooth.getAvailability().then((available) => {
    debug(`Bluetooth adapter available: ${available}`);
    showAvailability(available);
  }, (error) => debug(`Could not check for a Bluetooth adapter: ${describeError(error)}`));
  navigator.bluetooth.addEventListener('availabilitychanged', (event) => {
    debug(`Bluetooth adapter available changed to: ${event.value}`);
    showAvailability(event.value);
  });
}

/* ---------- Connecting ---------- */

async function onConnectClick() {
  const options = { filters: [{ services: [SVC_1802, SVC_1803, SVC_1804] }] };
  const filterName = $('#name').value;
  if (filterName) options.filters.push({ name: filterName });

  $('#scan').disabled = true;
  setConnectMessage('Choose your SKY2 in the browser’s Bluetooth window…');
  failedStep = null;
  debug(`--- Connect clicked. Filters: ${JSON.stringify(options.filters)}`);

  try {
    device = await debugStep('Choose device (requestDevice)', () => navigator.bluetooth.requestDevice(options));
    debug(`Chosen device name: ${device.name || '(none reported)'}`);
    device.addEventListener('gattserverdisconnected', logDisconnectEvent);
    device.addEventListener('gattserverdisconnected', onDisconnected);

    setConnectMessage('Connecting to your SKY2…');
    const server = await debugStep('Connect to GATT server', () => device.gatt.connect());

    const getCharacteristic = async (serviceUuid, characteristicUuid) => {
      const service = await debugStep(`Get service ${serviceUuid.slice(4, 8)}`, () => server.getPrimaryService(serviceUuid));
      const characteristic = await debugStep(`Get characteristic ${characteristicUuid.slice(4, 8)}`, () => service.getCharacteristic(characteristicUuid));
      debug(`Characteristic ${characteristicUuid.slice(4, 8)} properties: ${describeProperties(characteristic)}`);
      return characteristic;
    };
    deviceIdOrPass = await getCharacteristic(SVC_1802, CHAR_DEVICE_ID_OR_PASS);
    statusOrSsid = await getCharacteristic(SVC_1803, CHAR_STATUS_OR_SSID);
    command = await getCharacteristic(SVC_1804, CHAR_COMMAND);

    // The setup only writes, so a refused read shouldn't stop it. A lost connection still should.
    const readOptional = async (label, read) => {
      try {
        return await debugStep(label, read);
      } catch (error) {
        if (!isConnected()) throw error;
        return undefined;
      }
    };
    const unreadable = [];

    const idValue = await readOptional('Read device ID', () => deviceIdOrPass.readValue());
    if (idValue === undefined) {
      unreadable.push('device ID');
      $('#deviceid').value = 'Not available';
    } else {
      debug(`Device ID length: ${idValue.byteLength} bytes`);
      $('#deviceid').value = new TextDecoder('utf-8').decode(idValue);
    }

    const code = await readOptional('Read status', () => refreshStatus());
    if (code === undefined) {
      unreadable.push('status');
      $('#status').value = 'Not available';
    } else {
      debug(`Status on connect: ${describeStatus(code)}`);
    }

    showConnected(unreadable);
    debug(unreadable.length ? `Connected, but could not read: ${unreadable.join(', ')}` : 'Connected and ready');
  } catch (error) {
    const failedDevice = device;
    device = null; // Stops onDisconnected from replacing the message below.
    const cancelled = error.name === 'NotFoundError' && /cancel/i.test(error.message);

    if (failedDevice) {
      debug(`Still connected after the failure: ${failedDevice.gatt.connected}`);
      if (failedDevice.gatt.connected) {
        await logVisibleServices(failedDevice);
        failedDevice.gatt.disconnect();
      }
    }

    if (cancelled) {
      setConnectMessage('No device selected. Click Connect to try again.');
    } else {
      setConnectMessage(`Could not connect (${failedStep || 'unknown step'}): ${withoutFinalPeriod(error.message)}. See the debug log below.`, 'bad');
      $('#debug').open = true;
    }
    $('#scan').disabled = false;
  }
}

function logDisconnectEvent() {
  debug('Browser reported a disconnect (gattserverdisconnected)');
}

async function logVisibleServices(failedDevice) {
  try {
    const services = await failedDevice.gatt.getPrimaryServices();
    debug(`Services this page can see: ${services.map((service) => service.uuid.slice(4, 8)).join(', ') || 'none'}`);
  } catch (error) {
    debug(`Could not list services: ${describeError(error)}`);
  }
}

function showConnected(unreadable) {
  rebooting = false;
  const name = device.name || 'SKY2';
  if (unreadable.length) {
    setConnectMessage(`Connected to ${name}, but could not read its ${unreadable.join(' or ')}. You can still try the update below.`, 'warn');
    $('#debug').open = true;
  } else {
    setConnectMessage(`Connected to ${name}.`, 'ok');
  }
  $('#scan').textContent = 'Connected';
  setResult('');
  $('#progress').hidden = true;
  $('#reboot').classList.remove('primary');
  setControlsDisabled(false);
  $('#connectHelp').hidden = true;
  $('#devicePanel').hidden = false;
  $('#wifi_ssid').focus();
  statusMonitor = setInterval(checkStatusInBackground, STATUS_MONITOR_MS);
}

function onDisconnected(event) {
  if (event.target !== device) return;
  console.log('Bluetooth device disconnected');

  device = null;
  clearInterval(statusMonitor);
  // A request lost with the connection must not block the next connection.
  gattQueue = Promise.resolve();
  monitorReadPending = false;
  $('#devicePanel').hidden = true;
  $('#connectHelp').hidden = false;
  $('#scan').disabled = false;
  $('#scan').textContent = 'Connect to SKY2 via Bluetooth';

  if (disconnecting) {
    disconnecting = false;
    setConnectMessage('Disconnected. Your SKY2 was not rebooted.', 'ok');
  } else if (rebooting) {
    setConnectMessage('Your SKY2 is rebooting and has disconnected from Bluetooth. You can close this page.', 'ok');
  } else if (updating) {
    setConnectMessage('Your SKY2 disconnected before reporting a result. Connect again to check its status.', 'bad');
  } else {
    setConnectMessage('Your SKY2 disconnected. Connect again to continue.', 'warn');
  }
}

function onDisconnectClick() {
  if (!isConnected() || updating || rebooting) return;
  disconnecting = true;
  const connectedDevice = device;
  connectedDevice.gatt.disconnect();
  // Don't depend on the event's timing; onDisconnected ignores a repeat.
  onDisconnected({ target: connectedDevice });
}

/* ---------- Status ---------- */

function setStatusCheck(text, checking) {
  $('#statusCheck').classList.toggle('checking', checking);
  $('#statusCheckText').textContent = text;
  // The 5-second schedule doesn't apply during an update or reboot.
  $('#statusCheckSchedule').hidden = updating || rebooting;
}

async function refreshStatus() {
  setStatusCheck('Checking status…', true);
  try {
    const value = await queueGatt(() => statusOrSsid.readValue());
    const code = value.byteLength ? value.getUint8(0) : null;
    console.log(`Status is ${code}`);
    $('#status').value = describeStatus(code);
    setStatusCheck(`Last checked at ${new Date().toLocaleTimeString()}`, false);
    lastStatusError = null;
    return code;
  } catch (error) {
    // Repeated checks would otherwise fill the log with the same line.
    if (error.message !== lastStatusError) debug(`Status read failed: ${describeError(error)}`);
    lastStatusError = error.message;
    setStatusCheck(`Could not read status: ${error.message}`, false);
    throw error;
  }
}

async function checkStatusInBackground() {
  if (!isConnected() || updating || rebooting || monitorReadPending) return;
  monitorReadPending = true;
  try {
    await refreshStatus();
  } catch (error) {
    // refreshStatus has shown the error; the next check tries again.
  } finally {
    monitorReadPending = false;
  }
}

async function onRefreshClick() {
  if (!isConnected()) return;
  const button = $('#getStatus');
  button.disabled = true;
  try {
    await refreshStatus();
  } catch (error) {
    // refreshStatus has shown the error.
  } finally {
    // An update or reboot started meanwhile keeps its controls disabled.
    button.disabled = updating || rebooting;
  }
}

/* ---------- Updating Wi-Fi ---------- */

function setProgress(percent, headline) {
  $('#progressBar').value = percent;
  $('#progressHeadline').textContent = headline;
}

function addLog(text) {
  const item = document.createElement('li');
  item.textContent = text;
  const list = $('#progressLog');
  list.appendChild(item);
  list.scrollTop = list.scrollHeight;
  $('#progress').scrollIntoView({ block: 'nearest' });
}

async function sendWifiSettings(ssid, pass) {
  const encoder = new TextEncoder();
  const sendCommand = (code) => queueGatt(() => command.writeValue(new Uint8Array([code])));

  // The order of these writes is the SKY2's setup protocol. Each command picks
  // what the following write to the characteristics means.
  const steps = [
    ['Starting setup', () => sendCommand(1)],
    ['Preparing to receive the SSID', () => sendCommand(3)],
    ['Sending the SSID', () => queueGatt(() => statusOrSsid.writeValue(encoder.encode(ssid)))],
    ['Preparing to receive the password', () => sendCommand(2)],
    ['Sending the password', () => queueGatt(() => deviceIdOrPass.writeValue(encoder.encode(pass)))],
    ['Saving the Wi-Fi settings', () => sendCommand(4)],
    ['Starting the Wi-Fi connection test', () => sendCommand(5)],
  ];

  for (let i = 0; i < steps.length; i++) {
    const [label, run] = steps[i];
    setProgress(Math.round((i / steps.length) * 20), `${label}…`);
    addLog(label);
    await debugStep(`Update step ${i + 1} of ${steps.length}: ${label}`, run);
  }
}

/* Returns the final status code (null if none before the timeout), and whether
   any status could be read at all. */
async function waitForFinalStatus(statusBeforeUpdate) {
  const startedAt = Date.now();
  let statusWasRead = false;

  for (let check = 1; isConnected(); check++) {
    const elapsedMs = Date.now() - startedAt;
    const seconds = Math.round(elapsedMs / 1000);
    setProgress(
      20 + Math.min(80, Math.round((elapsedMs / STATUS_TIMEOUT_MS) * 80)),
      `Checking status (check ${check}, ${seconds}s of ${STATUS_TIMEOUT_MS / 1000}s)…`
    );

    try {
      const code = await refreshStatus();
      statusWasRead = true;
      debug(`Status after ${seconds}s: ${describeStatus(code)}`);
      const isFinal = code in FINAL_RESULTS;
      const isPossiblyStale = code === statusBeforeUpdate && elapsedMs < STALE_STATUS_GRACE_MS;

      if (isFinal && isPossiblyStale) {
        addLog(`${seconds}s: status ${describeStatus(code)} (may be from the last attempt, still checking)`);
      } else {
        addLog(`${seconds}s: status ${describeStatus(code)}`);
        if (isFinal) return { code, statusWasRead };
      }
    } catch (error) {
      if (!isConnected()) return { code: null, statusWasRead };
      addLog(`${seconds}s: could not read status (${error.message}), will retry`);
    }

    if (Date.now() - startedAt + STATUS_POLL_MS > STATUS_TIMEOUT_MS) return { code: null, statusWasRead };
    await sleep(STATUS_POLL_MS);
  }
  return { code: null, statusWasRead };
}

async function onUpdateSubmit(event) {
  event.preventDefault();
  if (updating || !isConnected()) return;

  const ssid = $('#wifi_ssid').value;
  const pass = $('#wifi_pass').value;
  if (ssid === '' || pass === '') {
    setResult('Please enter both the Wi-Fi SSID and password.', 'bad');
    return;
  }

  updating = true;
  setControlsDisabled(true);
  setResult('');
  $('#progressLog').replaceChildren();
  $('#progress').hidden = false;
  setProgress(0, 'Starting…');

  let locked = false;
  failedStep = null;
  debug('--- Update clicked');
  try {
    let statusBeforeUpdate = null;
    try {
      statusBeforeUpdate = await refreshStatus();
    } catch (error) {
      if (!isConnected()) throw error;
      addLog('Could not read the status first, continuing');
    }

    await sendWifiSettings(ssid, pass);
    addLog(`Waiting up to ${STATUS_TIMEOUT_MS / 1000}s for your SKY2 to report a result`);

    const { code, statusWasRead } = await waitForFinalStatus(statusBeforeUpdate);
    if (!isConnected()) return; // onDisconnected has already told the user.
    debug(`Update finished. Final status: ${code === null ? 'none' : describeStatus(code)}`);

    if (!statusWasRead) {
      setProgress(100, 'Settings sent, no status available');
      setResult(
        'The Wi-Fi settings were sent, but this device could not read the SKY2’s status to confirm them. ' +
        'Check whether the Wi-Fi icon stops blinking alternate colors, then click Reboot and see whether your station comes online.',
        'warn'
      );
    } else if (code === null) {
      setProgress(100, 'No result');
      setResult(
        `Your SKY2 did not report a result within ${STATUS_TIMEOUT_MS / 1000} seconds. ` +
        'Check the status once more, then try again or click Reboot.',
        'bad'
      );
    } else {
      setProgress(100, 'Finished');
      setResult(FINAL_RESULTS[code].text, FINAL_RESULTS[code].kind);
      if (code === 3) {
        locked = true;
        $('#reboot').classList.add('primary');
      }
    }
  } catch (error) {
    debug(`Update failed: ${describeError(error)}`);
    if (isConnected()) {
      setProgress($('#progressBar').value, 'Stopped');
      const where = failedStep ? ` (${failedStep})` : '';
      setResult(`Could not send the Wi-Fi settings${where}: ${withoutFinalPeriod(error.message)}. Try again.`, 'bad');
      $('#debug').open = true;
    }
  } finally {
    updating = false;
    if (isConnected()) {
      setControlsDisabled(false);
      if (locked) lockWifiForm();
    }
  }
}

/* ---------- Rebooting ---------- */

async function onRebootClick() {
  if (!isConnected()) return;
  const wifiFormLocked = $('#updatewifi').disabled;

  rebooting = true;
  setControlsDisabled(true);
  setStatusCheck('Status checks stopped for the reboot', false);
  setResult('Sending the reboot command…');
  try {
    await queueGatt(() => command.writeValue(new Uint8Array([7])));
    if (isConnected()) setResult('Reboot command sent. Your SKY2 should now restart.', 'ok');
  } catch (error) {
    // The SKY2 may restart before acknowledging the command, and the disconnect
    // can register late. Only report a failure if the link stays up.
    setResult('Confirming the reboot…');
    await sleep(REBOOT_DISCONNECT_WAIT_MS);
    if (isConnected()) {
      rebooting = false;
      setControlsDisabled(false);
      if (wifiFormLocked) lockWifiForm();
      setResult(`Could not send the reboot command: ${error.message}`, 'bad');
    }
  }
}

/* ---------- Wiring ---------- */

$('#connectForm').addEventListener('submit', (event) => {
  event.preventDefault();
  onConnectClick();
});
$('#wifiForm').addEventListener('submit', onUpdateSubmit);
$('#getStatus').addEventListener('click', onRefreshClick);
$('#reboot').addEventListener('click', onRebootClick);
$('#disconnect').addEventListener('click', onDisconnectClick);
$('#debugCopy').addEventListener('click', copyDebugLog);

showVersions();
logEnvironment().finally(checkBluetoothSupport);
