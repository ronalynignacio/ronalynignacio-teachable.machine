/* ===== CONFIG =====
   Paste your Teachable Machine model URL here (keep the trailing slash), e.g.
   "https://teachablemachine.withgoogle.com/models/fNqBtl6Ir/"
   Or export your model as TensorFlow.js > Download, put model.json,
   metadata.json and weights.bin inside ./my_model/ and keep "./my_model/".   */
const MODEL_URL = "https://teachablemachine.withgoogle.com/models/fNqBtl6Ir/";
const CAM_SIZE = 400;          // internal capture size (display scales with CSS)
const MIN_CONFIDENCE = 0.7;    // below this, the result shows "Not sure"
const STEP_CONFIDENCE = 0.85;  // confidence needed to count toward completing a step
const HOLD_MS = 1200;          // gesture must stay stable this long to complete a step

const $ = (id) => document.getElementById(id);
const landing = $("landing"), recognition = $("recognition");
const startBtn = $("startBtn"), backBtn = $("backBtn"), toggleBtn = $("toggleBtn");
const statusDot = $("statusDot"), statusText = $("statusText");
const camBox = $("webcam-container"), placeholder = $("camPlaceholder");
const labelBox = $("label-container"), errorBox = $("errorBox");
const resultName = $("resultName"), confText = $("confText"), confBar = $("confBar");

const STORE_KEY = "fsr_done";
const stepEls = [...document.querySelectorAll(".goal-sign")];
const stepsBox = $("steps"), progText = $("progText"), progBar = $("progBar");
const stepMsg = $("stepMsg"), holdBar = $("holdBar"), resetBtn = $("resetBtn");
const STEP_NAMES = ["One Finger", "Two Fingers", "Three Fingers"];
const WIN_MSG = "Congratulations! You completed all three finger signs!";
let done = [false, false, false], cand = 0, candSince = 0;
try { const s = JSON.parse(sessionStorage.getItem(STORE_KEY)); if (Array.isArray(s) && s.length === 3) done = s.map(Boolean); } catch (e) {}

let model = null, webcam = null, running = false, rafId = null, busy = false, rows = [];

function setStatus(state, text) {
  statusDot.className = "dot " + state;
  statusText.textContent = text;
}
function showError(title, msg) {
  errorBox.innerHTML = "<strong></strong><span></span>";
  errorBox.firstChild.textContent = title;
  errorBox.lastChild.textContent = msg;
  errorBox.hidden = false;
}
function clearError() { errorBox.hidden = true; }

function prettyName(name) {
  const n = name.toLowerCase();
  if (/\b(one|1)\b/.test(n)) return "One Finger";
  if (/\b(two|2)\b/.test(n)) return "Two Fingers";
  if (/\b(three|3)\b/.test(n)) return "Three Fingers";
  return name;
}

function stepOf(name) {
  const n = name.toLowerCase();
  if (/\b(one|1)\b/.test(n)) return 1;
  if (/\b(two|2)\b/.test(n)) return 2;
  if (/\b(three|3)\b/.test(n)) return 3;
  return 0;
}
function saveProgress() { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(done)); } catch (e) {} }
function setMsg(text, cls) { stepMsg.textContent = text; stepMsg.className = "step-msg" + (cls ? " " + cls : ""); }
function renderProgress(animateIdx) {
  const count = done.filter(Boolean).length;
  progText.textContent = count + " of 3 complete";
  progBar.style.width = Math.round(count / 3 * 100) + "%";
  stepEls.forEach((el, i) => {
    el.classList.toggle("done", done[i]);
    el.querySelector(".state").textContent = done[i] ? "Completed" : "Waiting";
    if (i === animateIdx) { el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop"); }
  });
  stepsBox.classList.toggle("all-done", count === 3);
}
function resetHold() { cand = 0; candSince = 0; holdBar.style.width = "0%"; stepEls.forEach((el) => el.classList.remove("active")); }
function trackStable(best) {
  const s = best.probability >= STEP_CONFIDENCE ? stepOf(best.className) : 0;
  if (!s || done[s - 1]) { resetHold(); return; }
  const now = performance.now();
  if (s !== cand) { resetHold(); cand = s; candSince = now; stepEls[s - 1].classList.add("active"); }
  const held = now - candSince;
  holdBar.style.width = Math.min(100, held / HOLD_MS * 100) + "%";
  if (held >= HOLD_MS) {
    done[s - 1] = true; saveProgress(); resetHold();
    renderProgress(s - 1);
    if (done.every(Boolean)) setMsg(WIN_MSG, "win");
    else setMsg("Step " + s + " complete: " + STEP_NAMES[s - 1] + " recognized!", "ok");
  }
}

function resetResult() {
  resultName.textContent = "Waiting for camera…";
  resultName.classList.add("dim");
  confText.textContent = "0%";
  confBar.style.width = "0%";
  rows.forEach((r) => { r.bar.style.width = "0%"; r.pct.textContent = "0%"; r.el.classList.remove("top"); });
}

async function loadModel() {
  if (model) return;
  const base = MODEL_URL.endsWith("/") ? MODEL_URL : MODEL_URL + "/";
  model = await tmImage.load(base + "model.json", base + "metadata.json");
  labelBox.innerHTML = "";
  rows = model.getClassLabels().map((label) => {
    const el = document.createElement("div");
    el.className = "row";
    el.innerHTML = '<div class="row-head"><span></span><span>0%</span></div><div class="bar"><i></i></div>';
    el.querySelector("span").textContent = prettyName(label);
    labelBox.appendChild(el);
    return { el, pct: el.querySelectorAll("span")[1], bar: el.querySelector("i") };
  });
}

function explainCameraError(err) {
  const name = err && err.name;
  if (!window.isSecureContext) return ["Camera needs a secure page", "Open this site over https:// or http://localhost. Browsers block cameras on insecure pages."];
  if (name === "NotAllowedError" || name === "SecurityError") return ["Camera permission denied", "Allow camera access in your browser's address bar or site settings, then press Start Recognition."];
  if (name === "NotFoundError" || name === "OverconstrainedError") return ["No camera found", "Connect a camera or switch to a device that has one, then press Start Recognition."];
  if (name === "NotReadableError") return ["Camera is in use", "Close other apps or tabs using the camera, then press Start Recognition."];
  return ["Could not start the camera", (err && err.message) || "Please try again."];
}

async function startRecognition() {
  if (running) return;
  clearError();
  toggleBtn.disabled = true;
  setStatus("loading", "Loading model…");
  try {
    await loadModel();
  } catch (err) {
    console.error(err);
    setStatus("err", "Model failed to load");
    showError("Could not load the model", "Check that MODEL_URL in script.js points to your exported Teachable Machine model and that the files are reachable.");
    toggleBtn.textContent = "Start Recognition"; toggleBtn.disabled = false;
    return;
  }
  setStatus("loading", "Requesting camera…");
  try {
    webcam = new tmImage.Webcam(CAM_SIZE, CAM_SIZE, true); // flipped like a mirror
    await webcam.setup({ facingMode: "user" });
    await webcam.play();
  } catch (err) {
    console.error(err);
    const [t, m] = explainCameraError(err);
    stopCamera();
    setStatus("err", "Camera unavailable");
    showError(t, m);
    toggleBtn.textContent = "Start Recognition"; toggleBtn.disabled = false;
    return;
  }
  placeholder.hidden = true;
  camBox.appendChild(webcam.canvas);
  webcam.canvas.setAttribute("aria-label", "Live camera feed");
  camBox.classList.add("live");
  running = true;
  setStatus("on", "Camera on");
  toggleBtn.textContent = "Stop Recognition"; toggleBtn.disabled = false;
  rafId = requestAnimationFrame(loop);
}

function stopCamera() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (webcam) {
    try { webcam.stop(); } catch (e) {}
    if (webcam.canvas && webcam.canvas.parentNode) webcam.canvas.parentNode.removeChild(webcam.canvas);
    webcam = null;
  }
  camBox.classList.remove("live");
  placeholder.hidden = false;
}

function stopRecognition() {
  stopCamera();
  setStatus("", "Camera off");
  resetHold();
  toggleBtn.textContent = "Start Recognition";
  resetResult();
}

async function loop() {
  if (!running) return;
  webcam.update();
  if (!busy) {
    busy = true;
    try { await predict(); } finally { busy = false; }
  }
  if (running) rafId = requestAnimationFrame(loop);
}

async function predict() {
  const preds = await model.predict(webcam.canvas); // real model output
  if (!running) return;
  let top = 0;
  preds.forEach((p, i) => {
    if (p.probability > preds[top].probability) top = i;
    const pct = Math.round(p.probability * 100);
    rows[i].bar.style.width = pct + "%";
    rows[i].pct.textContent = pct + "%";
    rows[i].el.classList.remove("top");
  });
  const best = preds[top], pct = Math.round(best.probability * 100);
  trackStable(best);
  rows[top].el.classList.add("top");
  confText.textContent = pct + "%";
  confBar.style.width = pct + "%";
  if (best.probability >= MIN_CONFIDENCE) {
    resultName.textContent = prettyName(best.className);
    resultName.classList.remove("dim");
  } else {
    resultName.textContent = "Not sure yet";
    resultName.classList.add("dim");
  }
}

function openRecognition() {
  landing.hidden = true;
  recognition.hidden = false;
  window.scrollTo(0, 0);
  resetResult();
  startRecognition();
}
function closeRecognition() {
  stopRecognition();
  clearError();
  recognition.hidden = true;
  landing.hidden = false;
  toggleBtn.textContent = "Stop Recognition";
  window.scrollTo(0, 0);
}

resetBtn.addEventListener("click", () => {
  done = [false, false, false]; saveProgress(); resetHold(); renderProgress(-1);
  setMsg("Progress reset. Show a sign and hold it steady.");
});
renderProgress(-1);
if (done.every(Boolean)) setMsg(WIN_MSG, "win");
else if (done.some(Boolean)) setMsg("Welcome back! Keep going to finish the remaining signs.");

startBtn.addEventListener("click", openRecognition);
backBtn.addEventListener("click", closeRecognition);
$("brandLink").addEventListener("click", (e) => { e.preventDefault(); if (!recognition.hidden) closeRecognition(); });
toggleBtn.addEventListener("click", () => { running ? stopRecognition() : startRecognition(); });

// Release the camera when the tab is hidden or the page is left
document.addEventListener("visibilitychange", () => { if (document.hidden && running) stopRecognition(); });
window.addEventListener("pagehide", stopCamera);
