/**
 * Game Engine for (DS) OpenCV Memory Game
 * Controls the 3 stages, sequence generation, memorization timer,
 * OpenCV gesture answering window, and scoring logic.
 */

class GameEngine {
  constructor() {
    this.currentStage = 1;
    this.stageConfigs = {
      1: { count: 5, displayInterval: 3000, responseInterval: 5000 },
      2: { count: 8, displayInterval: 2000, responseInterval: 4000 },
      3: { count: 9, displayInterval: 1500, responseInterval: 3000 },
    };

    this.activeSequence = [];
    this.userSequence = [];
    this.guessResults = [];
    this.currentInputIndex = 0;
    this.inputTimer = null;
    this.inputTimeLeft = 0;
    this.memorizeTimer = null;

    this.participant = null;
    this.team = null;
    this.stageScores = { 1: 0, 2: 0, 3: 0 };
    this.totalScore = 0;
  }

  async loadConfig() {
    const data = await window.platformApi("/games/memory/config");
    this.testMode = Boolean(data.testMode);
    for (let stage = 1; stage <= 3; stage++) {
      const cfg = data.stages["stage" + stage];
      this.stageConfigs[stage] = {
        count: cfg.numbersCount,
        displayInterval: cfg.displayIntervalSeconds * 1000,
        responseInterval: cfg.responseIntervalSeconds * 1000,
      };
      document.querySelector(
        "#step-pill-" + stage + " .step-label-full",
      ).textContent = "Stage " + stage + " (" + cfg.numbersCount + " Numbers)";
      document.querySelector(
        "#step-pill-" + stage + " .step-label-short",
      ).textContent = "Stage " + stage + " (" + cfg.numbersCount + ")";
    }
  }

  setParticipantData(participant, team) {
    this.participant = participant;
    this.team = team;
    if (participant.scores) {
      this.stageScores[1] = participant.scores.stage1 || 0;
      this.stageScores[2] = participant.scores.stage2 || 0;
      this.stageScores[3] = participant.scores.stage3 || 0;
      this.totalScore = participant.scores.total || 0;
    }
  }

  generateSequence(count) {
    // Only numbers 1 to 9, no 2 numbers shall repeat, cryptographically secure Fisher-Yates shuffle
    const pool = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const n = Math.min(count || 5, pool.length);
    const randBuffer = new Uint32Array(pool.length);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(randBuffer);
    } else {
      for (let i = 0; i < randBuffer.length; i++) {
        randBuffer[i] = Math.floor(Math.random() * 1000000);
      }
    }
    for (let i = pool.length - 1; i > 0; i--) {
      const j = randBuffer[i] % (i + 1);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, n);
  }

  // 1. Start Stage Flow
  async startStage(stageNum) {
    this.currentStage = stageNum;
    this._countdownPending = false;
    const briefingButton = document.querySelector("#stage-brief-screen button");
    if (briefingButton) briefingButton.disabled = false;
    const config = this.stageConfigs[stageNum];
    this._stagePrepared = false;
    this.activeSequence = [];
    this.userSequence = [];
    this.guessResults = [];
    this.currentInputIndex = 0;

    // Update UI Stage tracker
    document.querySelectorAll(".stage-step").forEach((el, idx) => {
      el.classList.toggle("active", idx + 1 === stageNum);
    });

    // Show Stage Briefing Screen
    document.getElementById("stage-brief-screen").style.display = "flex";
    document.getElementById("memorize-phase-screen").style.display = "none";
    const cvEl = document.getElementById("opencv-box-screen");
    if (cvEl) {
      cvEl.classList.remove("active");
      cvEl.style.display = "none";
    }
    document.getElementById("stage-review-screen").style.display = "none";
    document.getElementById("final-results-screen").style.display = "none";

    document.getElementById("brief-stage-title").textContent =
      `Stage ${stageNum} Briefing`;
    document.getElementById("brief-numbers-count").textContent =
      `${config.count} Numbers`;
    document.getElementById("brief-display-time").textContent =
      `${config.displayInterval / 1000}s Interval`;
    document.getElementById("brief-response-time").textContent = this.testMode
      ? "Unlimited Answer Time"
      : `${config.responseInterval / 1000}s Answer Time`;

    window.soundEngine.init();
  }

  // 2. Begin Countdown to Memorization
  async beginCountdown() {
    const button = document.querySelector("#stage-brief-screen button");
    if (this._countdownPending) return;
    this._countdownPending = true;
    if (button) button.disabled = true;
    try {
      button.textContent = "Preparing camera…";
      window.visionEngine.onFrameUpdate = null;
      window.visionEngine.onDigitLocked = null;
      const ready = await window.visionEngine.init(
        document.getElementById("webcam-video"),
        document.getElementById("vision-canvas"),
      );
      if (!ready || !(await window.visionEngine.startCamera()))
        throw new Error(
          "Hand gestures are required. Allow camera access and wait for hand tracking to be ready before starting.",
        );
      if (!this._stagePrepared) {
        const stage = await window.platformApi("/games/memory/stage/start", {
          stage: this.currentStage,
        });
        this.sessionId = stage.sessionId;
        this.activeSequence = stage.sequence;
        this.stageConfigs[this.currentStage] = {
          count: stage.config.numbersCount,
          displayInterval: stage.config.displayIntervalSeconds * 1000,
          responseInterval: stage.config.responseIntervalSeconds * 1000,
        };
        this._stagePrepared = true;
      }
      button.textContent = "Starting…";
      await window.platformApi("/games/memory/stage/countdown", {});
    } catch (e) {
      this._countdownPending = false;
      if (button) button.disabled = false;
      if (button) button.textContent = "Start memorization";
      window.app.showToast(e.message, "error");
      return;
    }
    document.getElementById("stage-brief-screen").style.display = "none";
    document.getElementById("memorize-phase-screen").style.display = "flex";
    const cvEl = document.getElementById("opencv-box-screen");
    if (cvEl) {
      cvEl.classList.remove("active");
      cvEl.style.display = "none";
    }

    // Render sequence step slots strip
    this.renderMemorizeSlotsStrip();

    let count = 3;
    const bigDigit = document.getElementById("memorize-digit");
    const label = document.getElementById("memorize-stage-indicator");
    const heading = document.getElementById("memorize-heading");
    const progFill = document.getElementById("memorize-progress-fill");
    const countdownText = document.getElementById("memorize-countdown-text");

    if (label) label.textContent = `GET READY! SEQUENCE STARTING`;
    if (heading) heading.textContent = `Sequence starting in ${count}...`;
    if (bigDigit) bigDigit.textContent = count;
    if (progFill) progFill.style.width = "100%";
    if (countdownText) countdownText.textContent = `${count}s`;
    window.soundEngine.playCountdownTick();

    const interval = setInterval(() => {
      count--;
      if (count > 0) {
        if (bigDigit) bigDigit.textContent = count;
        if (heading) heading.textContent = `Sequence starting in ${count}...`;
        if (countdownText) countdownText.textContent = `${count}s`;
        window.soundEngine.playCountdownTick();
      } else {
        clearInterval(interval);
        window.soundEngine.playGoBeep();
        this.runMemorizationSequence();
      }
    }, 1000);
  }

  renderMemorizeSlotsStrip() {
    const strip = document.getElementById("memorize-slots-strip");
    if (!strip) return;
    strip.innerHTML = "";
    const total = this.activeSequence.length;
    for (let i = 0; i < total; i++) {
      const slot = document.createElement("div");
      slot.className = "mem-slot-item";
      slot.id = `mem-slot-${i}`;
      slot.textContent = `#${i + 1}`;
      strip.appendChild(slot);
    }
  }

  // 3. Play the numbers sequence one-by-one (Ultra Prominent Sequence Display)
  runMemorizationSequence() {
    const config = this.stageConfigs[this.currentStage];
    let index = 0;
    const total = this.activeSequence.length;

    const showNext = () => {
      if (index >= total) {
        // Memorization finished -> Transition to Split Gesture Arena
        this.openOpenCVOutputBox();
        return;
      }

      const num = this.activeSequence[index];
      const bigDigit = document.getElementById("memorize-digit");
      const label = document.getElementById("memorize-stage-indicator");
      const heading = document.getElementById("memorize-heading");
      const progFill = document.getElementById("memorize-progress-fill");
      const countdownText = document.getElementById("memorize-countdown-text");

      // Update prominent sequence badges
      if (label) label.textContent = `SEQUENCE NUMBER ${index + 1} OF ${total}`;
      if (heading)
        heading.textContent = `Observe & Memorize Digit #${index + 1} of ${total}`;
      if (countdownText)
        countdownText.textContent = `${(config.displayInterval / 1000).toFixed(1)}s`;

      if (bigDigit) {
        bigDigit.textContent = num;
        bigDigit.parentElement.style.animation = "none";
        bigDigit.parentElement.offsetHeight; // trigger reflow
        bigDigit.parentElement.style.animation =
          "scale-pop 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)";
      }

      // Update memorization slots strip
      document.querySelectorAll(".mem-slot-item").forEach((slot, i) => {
        slot.classList.remove("active");
        if (i < index) slot.classList.add("passed");
        if (i === index) slot.classList.add("active");
      });

      window.soundEngine.playDigitBeep();

      // Animate progress bar fill over displayInterval
      if (progFill) {
        progFill.style.transition = "none";
        progFill.style.width = "100%";
        setTimeout(() => {
          progFill.style.transition = `width ${config.displayInterval}ms linear`;
          progFill.style.width = "0%";
        }, 40);
      }

      index++;
      this.memorizeTimer = setTimeout(showNext, config.displayInterval);
    };

    showNext();
  }

  // 4. Open OpenCV Output Box & Start Hand Gesture Answering
  async openOpenCVOutputBox() {
    const briefEl = document.getElementById("stage-brief-screen");
    if (briefEl) briefEl.style.display = "none";
    const memEl = document.getElementById("memorize-phase-screen");
    if (memEl) memEl.style.display = "none";
    const cvEl = document.getElementById("opencv-box-screen");
    if (cvEl) {
      cvEl.classList.add("active");
      cvEl.style.display = "flex";
    }

    // Populate Top Left: Team Name and Active Participant Name
    const tName = this.team
      ? this.team.name
      : localStorage.getItem("aarohan_team")
        ? JSON.parse(localStorage.getItem("aarohan_team")).name
        : "Team Alpha";
    const pName = this.participant
      ? this.participant.name
      : localStorage.getItem("aarohan_participant")
        ? JSON.parse(localStorage.getItem("aarohan_participant")).name
        : "Participant";
    const pRoll = this.participant
      ? this.participant.rollNumber
      : localStorage.getItem("aarohan_participant")
        ? JSON.parse(localStorage.getItem("aarohan_participant")).rollNumber
        : "";

    const teamEl = document.getElementById("arena-team-name");
    const memberEl = document.getElementById("arena-member-name");
    const rollEl = document.getElementById("arena-member-roll");
    const stagePill = document.getElementById("arena-stage-title-pill");

    if (teamEl) teamEl.textContent = tName;
    if (memberEl) memberEl.textContent = pName;
    if (rollEl) rollEl.textContent = pRoll ? `(Roll: ${pRoll})` : "";
    if (stagePill)
      stagePill.innerHTML = `<span class="status-dot"></span> <span>STAGE ${this.currentStage} IN PROGRESS</span>`;

    // Render Left Panel: Stage Sequence Grid & Start Answer Step immediately
    this.renderStageSequenceGrid();
    this.startAnswerStep(this.userSequence.length);

    // Frame update for HUD elements & instant correct gesture detection
    window.visionEngine.onDigitLocked = null; // Controlled by game engine
    window.visionEngine.onFrameUpdate = (data) => {
      this.updateHudOverlay(data);
    };

    // Initialize Camera asynchronously so page renders spontaneously without blocking
    const videoEl = document.getElementById("webcam-video");
    const canvasEl = document.getElementById("vision-canvas");

    window.visionEngine
      .init(videoEl, canvasEl)
      .then(() => {
        return window.visionEngine.startCamera();
      })
      .then((camStarted) => {
        if (!camStarted) {
          console.warn(
            "Camera could not be started. Hand gestures are required.",
          );
          const statusPill = document.getElementById("camera-hand-status");
          if (statusPill) statusPill.textContent = "Camera required";
        }
      })
      .catch((err) => {
        console.warn("Camera initialization error:", err);
      });
  }

  // Left Panel Grid of Sequence Numbers of this specific stage (Colourless until answered)
  renderStageSequenceGrid() {
    const grid = document.getElementById("stage-sequence-grid");
    if (!grid) return;
    grid.innerHTML = "";
    const total = this.activeSequence.length;

    const subtitle = document.getElementById("sequence-grid-subtitle");
    if (subtitle) {
      subtitle.textContent = `Stage ${this.currentStage} (${total} Digits)`;
    }

    const progCount = document.getElementById("sequence-progress-count");
    if (progCount) {
      progCount.textContent = `Answered: 0 / ${total}`;
    }

    for (let i = 0; i < total; i++) {
      const item = document.createElement("div");
      item.className = "stage-grid-item";
      item.id = `stage-slot-${i}`;
      item.innerHTML = `
        <div class="slot-idx">#${i + 1}</div>
        <div class="slot-icon" id="stage-slot-icon-${i}">—</div>
        <div class="slot-val" id="stage-slot-val-${i}">—</div>
      `;
      const saved = this.guessResults[i];
      if (saved) {
        item.classList.add(saved.correct ? "slot-correct" : "slot-wrong");
        if (saved.timedOut) item.classList.add("slot-timeout");
        item.querySelector(".slot-icon").textContent = saved.correct
          ? "✓"
          : "✗";
        item.querySelector(".slot-val").textContent = saved.digit;
      }
      grid.appendChild(item);
    }
  }

  getOrdinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // 5. Start answering for step `index`
  async startAnswerStep(index) {
    const config = this.stageConfigs[this.currentStage];
    const total = this.activeSequence.length;

    if (index >= total) {
      // Completed all inputs in stage!
      this.finishStage();
      return;
    }
    this.isStepLocked = true;
    let timing;
    try {
      timing = await window.platformApi("/games/memory/guess/start", {
        sessionId: this.sessionId,
        index,
      });
    } catch (error) {
      window.app.showToast(error.message, "error");
      return;
    }
    this.guessDeadline = timing.deadline;
    this.serverOffset = (timing.serverNow || Date.now()) - Date.now();

    this.currentInputIndex = index;
    this.expectedDigit = this.activeSequence[index];
    this.lastDetectedDigit = null;
    this.isStepLocked = false;
    this.correctHoldStartTime = null;
    this.currentHoldDigit = null;

    // Highlight current slot in Left Panel sequence grid (remains colourless until answered)
    document.querySelectorAll(".stage-grid-item").forEach((el, i) => {
      if (i === index) {
        el.classList.add("slot-active");
      } else {
        el.classList.remove("slot-active");
      }
    });

    const progCount = document.getElementById("sequence-progress-count");
    if (progCount) {
      progCount.textContent = `Answered: ${index} / ${total}`;
    }

    const ordinalStr = this.getOrdinal(index + 1);

    // 1. Central Top: Prominently show current sequence position
    const posNumber = document.getElementById("central-pos-number");
    if (posNumber) {
      posNumber.textContent = `SHOW SEQUENCE #${index + 1} OF ${total}`;
    }

    const posInstruction = document.getElementById("central-pos-instruction");
    if (posInstruction) {
      posInstruction.textContent = `Present the ${ordinalStr} number from memory`;
    }

    // Reset hold meter box
    const holdBox = document.getElementById("gesture-hold-meter-box");
    const holdFill = document.getElementById("hold-meter-fill");
    const holdTimer = document.getElementById("hold-meter-timer");
    const holdTitle = document.getElementById("hold-meter-title");
    const cameraHudHoldFill = document.getElementById("camera-hud-hold-fill");
    const cameraHandStatus = document.getElementById("camera-hand-status");

    if (holdBox)
      holdBox.classList.remove(
        "holding-correct",
        "holding-wrong",
        "hold-complete",
      );
    if (holdFill) holdFill.style.width = "0%";
    if (cameraHudHoldFill) cameraHudHoldFill.style.width = "0%";
    if (holdTimer) holdTimer.textContent = "0.0s / 1.0s";
    if (holdTitle)
      holdTitle.textContent = "⏱️ Hold correct gesture for 1.0s to confirm";
    if (cameraHandStatus)
      cameraHandStatus.classList.remove("status-pill-holding");

    // Reset status ribbon
    const statusIcon = document.getElementById("central-status-icon");
    const statusText = document.getElementById("central-status-text");
    if (statusIcon) statusIcon.textContent = "⏱️";
    if (statusText)
      statusText.innerHTML = `Hold <strong>correct gesture</strong> continuously for <strong>1.0s</strong> to confirm & advance &middot; ${this.testMode ? "Unlimited practice" : "Otherwise the last gesture is recorded at timeout"}`;

    // Reset central detected digit and clear green tick mark
    const centralCard = document.getElementById("central-detected-card");
    if (centralCard)
      centralCard.classList.remove("match-correct", "match-timeout");
    const digitDisplay = document.getElementById("central-detected-digit");
    if (digitDisplay) digitDisplay.textContent = "--";

    // 2. Below that: Show the Timer
    const duration = config.responseInterval;
    this.inputTimeLeft = duration / 1000;

    if (this.inputTimer) clearInterval(this.inputTimer);

    const timerDigits = document.getElementById("central-countdown-text");
    const timerFill = document.getElementById("central-timer-fill");
    const timerCard = document.getElementById("central-timer-card");

    if (timerDigits)
      timerDigits.textContent = `${this.inputTimeLeft.toFixed(1)}s`;
    if (timerFill) timerFill.style.width = "100%";
    if (timerCard) timerCard.className = "central-timer-card timer-normal";

    if (this.testMode) {
      if (timerDigits) timerDigits.textContent = "∞";
      return;
    }
    this.inputTimer = setInterval(() => {
      const left = Math.max(
        0,
        (this.guessDeadline - Date.now() - this.serverOffset) / 1000,
      );
      this.inputTimeLeft = left;

      if (timerDigits) timerDigits.textContent = `${left.toFixed(1)}s`;

      const pct = Math.max(0, Math.min(100, (left / (duration / 1000)) * 100));
      if (timerFill) timerFill.style.width = `${pct}%`;

      if (timerCard) {
        if (left <= 1.5) {
          timerCard.className = "central-timer-card timer-urgent";
        } else if (left <= 2.5) {
          timerCard.className = "central-timer-card timer-warning";
        } else {
          timerCard.className = "central-timer-card timer-normal";
        }
      }

      if (left <= 0) {
        clearInterval(this.inputTimer);
        if (this.isStepLocked) return;
        this.isStepLocked = true;

        // Timer expired! User did NOT show correct answer
        // "if correct answer not detected wait till the timer ends. The number at the last should be considered as answer then."
        const finalDigit =
          this.lastDetectedDigit !== null
            ? this.lastDetectedDigit
            : window.visionEngine.currentDigit !== null
              ? window.visionEngine.currentDigit
              : 0;

        if (statusText) {
          statusText.textContent = `Time expired. Recording the last gesture: ${finalDigit}`;
        }

        this.handleDigitLocked(finalDigit, false, true);
      }
    }, 40);
  }

  // Frame update from camera stream
  updateHudOverlay(data) {
    // Freeze the recorded result while feedback is shown or a save is pending.
    if (this.isStepLocked) return;
    const digitDisplay = document.getElementById("central-detected-digit");
    const handsBreakdown = document.getElementById("central-hands-breakdown");
    const cameraHandStatus = document.getElementById("camera-hand-status");
    const statusIcon = document.getElementById("central-status-icon");
    const statusText = document.getElementById("central-status-text");

    const holdBox = document.getElementById("gesture-hold-meter-box");
    const holdFill = document.getElementById("hold-meter-fill");
    const holdTimer = document.getElementById("hold-meter-timer");
    const holdTitle = document.getElementById("hold-meter-title");
    const cameraHudHoldFill = document.getElementById("camera-hud-hold-fill");

    const detected = data.detectedDigit;

    if (detected !== null) {
      this.lastDetectedDigit = detected;
      if (digitDisplay) digitDisplay.textContent = detected;
      if (cameraHandStatus && !this.correctHoldStartTime)
        cameraHandStatus.textContent = `Hand: ${detected}`;

      const handStr = data.handDetails
        .map((h) => `${h.label}: ${h.count}`)
        .join(" | ");
      if (handsBreakdown)
        handsBreakdown.textContent = `${handStr} (Fingers: ${data.totalExtended})`;
    } else {
      if (digitDisplay && !this.isStepLocked) digitDisplay.textContent = "--";
      if (cameraHandStatus) cameraHandStatus.textContent = "Waiting for hand";
      if (handsBreakdown)
        handsBreakdown.textContent = "Show hand in camera view (0 to 9)";
    }

    // 1-second continuous hold threshold requirement:
    // The participant must hold the correct gesture continuously for 1.0s to confirm & advance.
    // If an incorrect gesture is held, do not advance early (let them keep trying until the timer expires).
    if (!this.isStepLocked && this.expectedDigit !== undefined) {
      const isCorrect = detected !== null && detected === this.expectedDigit;

      if (isCorrect) {
        if (this.currentHoldDigit !== detected || !this.correctHoldStartTime) {
          this.correctHoldStartTime = Date.now();
          this.currentHoldDigit = detected;
        }

        const elapsed = Date.now() - this.correctHoldStartTime;
        const holdProgress = Math.min(elapsed / 1000, 1.0); // 1.0s = 1000ms
        const pctStr = `${(holdProgress * 100).toFixed(1)}%`;
        const timeStr = `${(Math.min(elapsed, 1000) / 1000).toFixed(1)}s`;

        if (holdBox) {
          holdBox.classList.add("holding-correct");
          holdBox.classList.remove("holding-wrong");
        }
        if (holdFill) holdFill.style.width = pctStr;
        if (cameraHudHoldFill) cameraHudHoldFill.style.width = pctStr;
        if (holdTimer) holdTimer.textContent = `${timeStr} / 1.0s`;
        if (holdTitle) {
          holdTitle.innerHTML = `🎯 <strong>Target Match (${detected})!</strong> Holding to confirm...`;
        }

        if (cameraHandStatus) {
          cameraHandStatus.textContent = `Match! ${timeStr}/1.0s`;
          cameraHandStatus.classList.add("status-pill-holding");
        }
        if (statusIcon) statusIcon.textContent = "🎯";
        if (statusText) {
          statusText.innerHTML = `<strong style="color: var(--accent-green); font-size: 0.95rem;">CORRECT GESTURE (${detected})!</strong> Holding continuously: ${timeStr} / 1.0s to confirm...`;
        }

        if (elapsed >= 1000) {
          // 1.0s continuous threshold reached! Lock in early & advance!
          this.isStepLocked = true;
          if (this.inputTimer) clearInterval(this.inputTimer);

          if (holdBox) holdBox.classList.add("hold-complete");
          if (holdFill) holdFill.style.width = "100%";
          if (cameraHudHoldFill) cameraHudHoldFill.style.width = "100%";
          if (holdTimer) holdTimer.textContent = "1.0s / 1.0s ✓";
          if (statusIcon) statusIcon.textContent = "✅";
          if (statusText) {
            statusText.innerHTML = `<strong style="color: var(--accent-green); font-size: 1rem;">CONFIRMED CORRECT NUMBER (${detected})!</strong> Moving to next number...`;
          }
          if (cameraHandStatus) {
            cameraHandStatus.textContent = `Confirmed (${detected}) ✓`;
          }

          this.handleDigitLocked(detected, true);
        }
      } else {
        // Not correct answer (wrong digit or no hand shown)
        this.correctHoldStartTime = null;
        this.currentHoldDigit = null;

        if (holdBox) {
          holdBox.classList.remove("holding-correct", "hold-complete");
        }
        if (holdFill) holdFill.style.width = "0%";
        if (cameraHudHoldFill) cameraHudHoldFill.style.width = "0%";
        if (holdTimer) holdTimer.textContent = "0.0s / 1.0s";
        if (cameraHandStatus) {
          cameraHandStatus.classList.remove("status-pill-holding");
        }

        if (detected !== null) {
          if (holdBox) holdBox.classList.add("holding-wrong");
          if (holdTitle) {
            holdTitle.innerHTML = `Showing: <strong>${detected}</strong> &middot; ${this.testMode ? "Unlimited practice" : "Waiting for target gesture or timeout"}`;
          }
          if (statusIcon) statusIcon.textContent = "✋";
          if (statusText) {
            statusText.innerHTML = `Showing: <strong>${detected}</strong> &middot; ${this.testMode ? "Keep trying; no time limit" : "Keep trying until timeout or show the target gesture"}`;
          }
        } else {
          if (holdBox) holdBox.classList.remove("holding-wrong");
          if (holdTitle) {
            holdTitle.innerHTML = `⏱️ Hold correct answer for 1.0s to confirm`;
          }
          if (statusIcon) statusIcon.textContent = "⏱️";
          if (statusText) {
            statusText.innerHTML = `Hold <strong>correct answer</strong> for <strong>1.0s</strong> to confirm & advance &middot; ${this.testMode ? "Unlimited practice" : "Otherwise the last gesture is recorded at timeout"}`;
          }
        }
      }
    }
  }

  // 6. Handle Digit Locked & Update Stage Sequence Grid (Green if correct, Red if wrong)
  async handleDigitLocked(digit, isCorrect = false, timedOut = false) {
    if (!isCorrect && !timedOut) return;
    if (this.inputTimer) clearInterval(this.inputTimer);
    this.isStepLocked = true;
    this.correctHoldStartTime = null;
    this.currentHoldDigit = null;
    try {
      const result = await window.platformApi("/games/memory/guess", {
        sessionId: this.sessionId,
        index: this.currentInputIndex,
        digit,
      });
      digit = result.digit;
      isCorrect = result.correct;
      timedOut = result.timedOut;
    } catch (error) {
      window.app.showToast(
        error.message + " Retry saving this guess.",
        "error",
      );
      const status = document.getElementById("central-status-text");
      if (status) {
        status.textContent = error.message;
        const retry = document.createElement("button");
        retry.textContent = "Retry saving guess";
        retry.onclick = () =>
          this.handleDigitLocked(digit, isCorrect, timedOut);
        status.appendChild(retry);
      }
      return;
    }

    const holdBox = document.getElementById("gesture-hold-meter-box");
    const cameraHudHoldFill = document.getElementById("camera-hud-hold-fill");
    const cameraHandStatus = document.getElementById("camera-hand-status");

    if (holdBox) holdBox.classList.remove("holding-correct", "holding-wrong");
    if (cameraHudHoldFill) cameraHudHoldFill.style.width = "0%";
    if (cameraHandStatus)
      cameraHandStatus.classList.remove("status-pill-holding");

    window.soundEngine.playLockIn();
    this.userSequence.push(digit);
    this.guessResults.push({ digit, correct: isCorrect, timedOut });

    // Update central detected card visual state
    const centralCard = document.getElementById("central-detected-card");
    const digitDisplay = document.getElementById("central-detected-digit");
    if (digitDisplay) digitDisplay.textContent = digit;
    if (centralCard) centralCard.classList.toggle("match-timeout", timedOut);
    const status = document.getElementById("central-status-text");
    if (status)
      status.textContent = timedOut
        ? `✕ ${digit} · Timed out · 0 points. Moving to the next number.`
        : isCorrect
          ? `✓ ${digit} · Correct · +1 point. Moving to the next number.`
          : `✕ ${digit} · Incorrect · 0 points.`;

    if (isCorrect) {
      // User rule: "if the shown digit is correct, make the digit icon green, show a large tick mark and then move to the next number"
      if (centralCard) centralCard.classList.add("match-correct");
    } else {
      if (centralCard) centralCard.classList.remove("match-correct");
    }

    // Update the slot in the Left stage sequence grid (Green if correct, Red if wrong)
    const slotItem = document.getElementById(
      `stage-slot-${this.currentInputIndex}`,
    );
    const slotIcon = document.getElementById(
      `stage-slot-icon-${this.currentInputIndex}`,
    );
    const slotVal = document.getElementById(
      `stage-slot-val-${this.currentInputIndex}`,
    );

    if (slotItem) {
      slotItem.classList.remove("slot-active");
      if (isCorrect) {
        // User rule: "If answered correctly make the cell corresponding to it green"
        slotItem.classList.add("slot-correct");
        slotItem.classList.remove("slot-wrong");
        if (slotIcon) slotIcon.textContent = "✓";
        if (slotVal) slotVal.textContent = digit;
      } else {
        // User rule: "if answered wrong then make it red"
        slotItem.classList.add("slot-wrong");
        if (timedOut) slotItem.classList.add("slot-timeout");
        slotItem.classList.remove("slot-correct");
        if (slotIcon) slotIcon.textContent = "✗";
        if (slotVal) slotVal.textContent = digit;
      }
    }

    const progCount = document.getElementById("sequence-progress-count");
    if (progCount) {
      progCount.textContent = `Answered: ${this.userSequence.length} / ${this.activeSequence.length}`;
    }

    // Brief delay before advancing to next step (allows user to see large green tick mark)
    const delay = timedOut ? 850 : isCorrect ? 420 : 280;
    setTimeout(() => {
      if (centralCard) centralCard.classList.remove("match-correct");
      this.startAnswerStep(this.currentInputIndex + 1);
    }, delay);
  }

  // 7. Finish Stage, Calculate Score, and Submit
  async finishStage() {
    if (this.inputTimer) clearInterval(this.inputTimer);
    window.visionEngine.stopCamera();
    const cvEl = document.getElementById("opencv-box-screen");
    if (cvEl) {
      cvEl.classList.remove("active");
      cvEl.style.display = "none";
    }
    document.getElementById("stage-review-screen").style.display = "flex";

    // Judging criteria: Count of right numbers in matching positions = points
    let stageScore = 0;
    const total = this.activeSequence.length;

    for (let i = 0; i < total; i++) {
      if (this.guessResults[i]?.correct === true) {
        stageScore++;
      }
    }

    this.stageScores[this.currentStage] = stageScore;
    this.totalScore =
      (this.stageScores[1] || 0) +
      (this.stageScores[2] || 0) +
      (this.stageScores[3] || 0);

    // Render review UI
    document.getElementById("review-stage-title").textContent =
      `Stage ${this.currentStage} Results`;
    document.getElementById("review-score-num").textContent = stageScore;
    document.getElementById("review-score-denom").textContent =
      `out of ${total} points`;

    const compareGrid = document.getElementById("review-compare-grid");
    compareGrid.innerHTML = "";

    for (let i = 0; i < total; i++) {
      const orig = this.activeSequence[i];
      const user = this.userSequence[i];
      const isMatch = this.guessResults[i]?.correct === true;
      const timedOut = this.guessResults[i]?.timedOut;

      const col = document.createElement("div");
      col.className = "compare-col";
      col.innerHTML = `
        <div class="orig-box" title="Expected">${orig}</div>
        <div class="user-box ${isMatch ? "match" : "mismatch"}${timedOut ? " slot-timeout" : ""}" title="${timedOut ? "Timed out" : "Your Gesture"}">${user}</div>
        <span style="font-size:0.75rem; color:${isMatch ? "#10b981" : "#ef4444"}">${isMatch ? "✓" : "✗"}</span>
      `;
      compareGrid.appendChild(col);
    }

    if (stageScore > total / 2) {
      window.soundEngine.playSuccess();
    } else {
      window.soundEngine.playError();
    }

    // Submit answers, never a client-calculated score. Retry the same stage after a network failure.
    const nextBtnSubmit = document.getElementById("btn-review-next");
    nextBtnSubmit.disabled = true;
    const submit = async () => {
      nextBtnSubmit.disabled = true;
      nextBtnSubmit.textContent = "Saving result...";
      try {
        let data;
        try {
          data = await window.platformApi("/games/memory/submit", {
            stage: this.currentStage,
            digits: this.userSequence,
          });
        } catch (submissionError) {
          // The write may have committed even if its response was lost. Read persisted results before retrying.
          const state = await window.platformApi("/games/memory/state");
          const saved = state.stages.find((s) => s.stage === this.currentStage);
          if (!saved) throw submissionError;
          data = { score: saved.score, total: state.score };
        }
        this.stageScores[this.currentStage] = data.score;
        this.totalScore = data.total;
        document.getElementById("review-score-num").textContent = data.score;
        document.getElementById("review-team-total").textContent =
          "Your total: " + data.total + " pts";
        nextBtnSubmit.disabled = false;
        nextBtnSubmit.textContent =
          this.currentStage < 3
            ? "Proceed to Stage " + (this.currentStage + 1) + " →"
            : "View Final Score & Results";
        nextBtnSubmit.onclick = () =>
          this.currentStage < 3
            ? this.startStage(this.currentStage + 1).catch((e) =>
                window.app.showToast(e.message, "error"),
              )
            : this.showFinalResults();
      } catch (error) {
        window.app.showToast(error.message, "error");
        nextBtnSubmit.disabled = false;
        nextBtnSubmit.textContent = "Retry saving result";
        nextBtnSubmit.onclick = submit;
      }
    };
    await submit();
  }

  // 8. Show Final Results Certificate
  showFinalResults() {
    window.visionEngine.stopCamera();
    const cvEl = document.getElementById("opencv-box-screen");
    if (cvEl) {
      cvEl.classList.remove("active");
      cvEl.style.display = "none";
    }
    document.getElementById("stage-review-screen").style.display = "none";
    document.getElementById("final-results-screen").style.display = "flex";

    document.getElementById("final-player-name").textContent =
      this.participant.name;
    document.getElementById("final-player-roll").textContent =
      `Roll No: ${this.participant.rollNumber}`;
    document.getElementById("final-team-name").textContent =
      `Team: ${this.team.name} (${this.team.code})`;

    document.getElementById("final-s1-score").textContent =
      `${this.stageScores[1]} / ${this.stageConfigs[1].count}`;
    document.getElementById("final-s2-score").textContent =
      `${this.stageScores[2]} / ${this.stageConfigs[2].count}`;
    document.getElementById("final-s3-score").textContent =
      `${this.stageScores[3]} / ${this.stageConfigs[3].count}`;

    document.getElementById("final-total-score").textContent = this.totalScore;
    window.soundEngine.playSuccess();
  }
}

window.gameEngine = new GameEngine();
