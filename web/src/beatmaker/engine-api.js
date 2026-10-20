// Injected inside the original engine's closure at build time. Original extension stays intact.
window.musikeBeatmakerEngine = {
  snapshot() {
    const saved = localStorage.getItem('ytbm_cues_' + getCurrentVideoID());
    return { cues: Object.fromEntries(Object.keys(cuePoints).map(key => [key, getCueTime(key)])), pitch: pitchPercentage,
      rateMode: speedOnlyMode ? (speedHDMode ? 'SPEED HD' : 'SPEED') : 'PITCH', rateTarget: pitchTarget,
      rateMin: pitchSemitoneMode ? -75 : PITCH_PERCENT_MIN, rateMax: pitchSemitoneMode ? 300 : PITCH_PERCENT_MAX,
      saved: saved === JSON.stringify(cuePoints) || (!saved && Object.keys(cuePoints).length === 0),
      ready: !!panelContainer,
      mediaReady: !!getVideoElement() && getVideoElement().readyState >= 1 && Number.isFinite(getVideoElement().duration) };
  },
  cue(key, overwrite = false) {
    const media = getVideoElement();
    if (!media || !Number.isFinite(media.duration)) throw new Error('Wait for a track to finish loading before marking a cue.');
    if (overwrite || getCueTime(key) === undefined) {
      pushUndoState(); setCueAtKey(key, media.currentTime); saveCuePointsToURL(); updateCueMarkers(); refreshCuesButton();
    } else {
      sequencerTriggerCue(key); media.play().catch(error => window.dispatchEvent(new CustomEvent('beatmaker-error', { detail: error.message })));
    }
  },
  remove(key) { pushUndoState(); delete cuePoints[key]; saveCuePointsToURL(); updateCueMarkers(); refreshCuesButton(); },
  bank() { undoStack = []; redoStack = []; cuePoints = {}; loadCuePointsAtStartup(); refreshCuesButton(); },
  random() { placeRandomCues(); },
  pitch(value) { updatePitch(pitchSemitoneMode ? 12 * Math.log2(1 + value / 100) : value); },
  advanced() {
    if (!panelContainer) return;
    if (!panelContainer.dataset.musikePositioned) {
      if (!panelContainer.style.left) { panelContainer.style.top = '140px'; panelContainer.style.right = '24px'; }
      panelContainer.dataset.musikePositioned = '1';
    }
    panelContainer.style.display = panelContainer.style.display === 'none' ? 'block' : 'none';
  },
  sequencer() { if (touchPopup && touchPopup.style.display !== 'none') touchPopup.style.display = 'none'; else buildTouchPopup(); },
  sidechain() { toggleSidechainWindow(); },
  fx() { showFxPadWindowToggle().catch(error => window.dispatchEvent(new CustomEvent('beatmaker-error', { detail: error.message }))); },
  vj() { showVJWindowToggle(); },
  mapping() { showMIDIMapWindowToggle(); },
  mini() {
    goMinimalUI({ show: !(minimalUIContainer && minimalActive && minimalVisible) });
    if (minimalUIContainer && !minimalUIContainer.querySelector('.bm-close-engine-bar')) {
      const close = document.createElement('button');
      close.className = 'looper-btn bm-close-engine-bar'; close.textContent = '×';
      close.setAttribute('aria-label', 'Close cue controls');
      close.addEventListener('click', () => hideMinimalUIBar());
      minimalUIContainer.appendChild(close);
    }
  },
};
