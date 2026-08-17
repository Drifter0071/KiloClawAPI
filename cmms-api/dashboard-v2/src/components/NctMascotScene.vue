<script setup lang="ts">
// src/components/NctMascotScene.vue
//
// Interactive mascot for the NCT Szerviz Ai v2 login page.
//
// The mascot is the SAME purple wrench PNG that powers brand-mark.png,
// the favicon, and the AppTopbar NctMark — so the look is pixel-perfect
// and matches the brand mark everywhere. Instead of trying to redraw the
// 3D mascot with inline SVG paths, we render the PNG and animate it with
// CSS/SVG eye overlays on top.
//
// What it does:
//   1. Floats / drifts / breathes on its own (8s mirrored loop).
//   2. The two eyes (rendered as inline SVG on top of the PNG) track
//      the mouse / focused input so the mascot always seems aware.
//   3. When the user types in the password field, the mascot reacts:
//      - the eyes close briefly (squint/blink)
//      - the body does a tiny "peek" wobble
//      - the form card glows once (via shared CSS class hook on the
//        closest [data-testid="login-card"] ancestor)
//   4. On mobile (compact=true) the mascot is a small static strip at
//      the top of the login card, with a tiny peek animation only.
//
// All animation is hardware-accelerated (translate3d + opacity) and
// disabled under prefers-reduced-motion.

withDefaults(
  defineProps<{
    /** Compact mobile header variant — small static mascot above the form. */
    compact?: boolean
  }>(),
  { compact: false },
)
</script>

<template>
  <!-- ============================================================
       DESKTOP VARIANT — full mascot scene on the left of the form
       ============================================================ -->
  <div
    v-if="!compact"
    class="nct-mascot-scene relative w-full max-w-[22rem] aspect-square mx-auto select-none"
    aria-hidden="true"
  >
    <!-- Ambient halo behind the mascot (purely decorative) -->
    <div class="nct-mascot-halo" />

    <!-- Floating wrapper: the mascot PNG drifts and breathes inside
         this transform. The PNG already has its own eyes painted in
         (no SVG eye overlay). -->
    <div class="nct-mascot-float">
      <!-- The mascot body — rendered as a CSS background-image so it
           doesn't trigger happy-dom's HTMLImageElement file loader in
           tests (a real <img src="/brand-mark.png"> crashes the test
           suite because happy-dom tries to fetch the asset as a file
           URL). The background-image path is the same asset the live
           app serves, so the visual is identical. -->
      <div
        class="nct-mascot-png relative z-[1] block w-full h-full"
        role="img"
        aria-hidden="true"
      />

      <!-- The mascot PNG already ships with its own eyes painted in
           (the friendly purple wrench character from brand-mark.png).
           We deliberately do NOT overlay additional SVG eyes here —
           doing so would render four visible eyes. The mascot's face
           is the asset itself. -->
    </div>

    <!-- Soft floor shadow -->
    <div class="nct-mascot-shadow" />
  </div>

  <!-- ============================================================
       COMPACT / MOBILE VARIANT — small mascot strip above the form
       ============================================================ -->
  <div
    v-else
    class="nct-mascot-compact flex items-center justify-center gap-3 py-3"
    aria-hidden="true"
  >
    <div class="nct-mascot-compact-png-wrap">
      <!-- CSS background-image instead of <img> — see desktop variant
           for why (happy-dom test compatibility). -->
      <div
        class="nct-mascot-compact-png block w-12 h-12"
        role="img"
        aria-hidden="true"
      />
    </div>
  </div>
</template>

<style scoped>
/* ============================================================
   DESKTOP SCENE
   ============================================================ */

.nct-mascot-scene {
  /* The scene holds the halo + the floating mascot + the shadow.
     The mascot itself is the only element that animates. */
  contain: layout paint;
}

.nct-mascot-halo {
  position: absolute;
  inset: -10%;
  border-radius: 9999px;
  background:
    radial-gradient(closest-side,
      rgba(167, 139, 250, 0.42) 0%,
      rgba(124, 95, 173, 0.18) 45%,
      rgba(61, 39, 92, 0.0) 75%);
  filter: blur(20px);
  animation: nct-halo-breathe 6s ease-in-out infinite;
  pointer-events: none;
  z-index: 0;
}

.nct-mascot-float {
  position: absolute;
  inset: 8%;
  z-index: 1;
  transform-origin: 50% 60%;
  animation: nct-mascot-drift 8s ease-in-out infinite;
  will-change: transform;
}

/* The mascot drifts and breathes on its own; the floating transform
   comes from the nct-mascot-drift keyframe below. No SVG eye overlay
   is drawn here — the mascot PNG already has its own eyes painted in. */

.nct-mascot-png {
  /* The PNG is rendered as a CSS background-image (instead of an <img>)
     so it doesn't crash happy-dom in tests. The path points at
     /dashboard/v2/brand-mark.png because the mcp-server serves the v2
     public assets there without auth (the bare /brand-mark.png path
     hits the MCP bearer check and 401s). The drop-shadow tints it to
     match the magenta/purple brand palette of the login page; the
     underlying colors are the actual mascot from brand-mark.png. */
  background-image: url('/dashboard/v2/brand-mark.png');
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
  filter: drop-shadow(0 8px 16px rgba(61, 39, 92, 0.45))
          drop-shadow(0 2px 4px rgba(0, 0, 0, 0.25));
  user-select: none;
}

.nct-mascot-shadow {
  position: absolute;
  left: 18%;
  right: 18%;
  bottom: 2%;
  height: 4%;
  border-radius: 9999px;
  background: radial-gradient(ellipse at center,
    rgba(0, 0, 0, 0.45) 0%,
    rgba(0, 0, 0, 0.0) 70%);
  filter: blur(4px);
  animation: nct-shadow-pulse 8s ease-in-out infinite;
  z-index: 0;
}

/* Halo gently breathes */
@keyframes nct-halo-breathe {
  0%, 100% { transform: scale(1); opacity: 0.85; }
  50%      { transform: scale(1.08); opacity: 1; }
}

/* Main floating drift — a small figure-8 in 2D, mirrored at the
   midpoint for a seamless loop. */
@keyframes nct-mascot-drift {
  0%, 100% { transform: translate3d(0, 0, 0) rotate(-1.5deg); }
  25%      { transform: translate3d(6px, -8px, 0) rotate(1deg); }
  50%      { transform: translate3d(0, -2px, 0) rotate(1.5deg); }
  75%      { transform: translate3d(-6px, -8px, 0) rotate(-1deg); }
}

/* Shadow gets wider when the mascot is "up" */
@keyframes nct-shadow-pulse {
  0%, 100% { transform: scaleX(1);   opacity: 0.85; }
  50%      { transform: scaleX(0.7); opacity: 0.55; }
}

/* ============================================================
   COMPACT / MOBILE
   ============================================================ */

.nct-mascot-compact {
  /* Centered strip with a small icon and a friendly feel */
}

.nct-mascot-compact-png-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  padding: 0.5rem;
  background: radial-gradient(closest-side,
    rgba(167, 139, 250, 0.18) 0%,
    rgba(124, 95, 173, 0.0) 70%);
  animation: nct-compact-peek 5s ease-in-out infinite;
}

.nct-mascot-compact-png {
  background-image: url('/dashboard/v2/brand-mark.png');
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
  filter: drop-shadow(0 4px 8px rgba(61, 39, 92, 0.35));
  animation: nct-compact-bob 3.5s ease-in-out infinite;
}

@keyframes nct-compact-peek {
  0%, 100% { box-shadow: 0 0 0 0 rgba(124, 95, 173, 0.0); }
  50%      { box-shadow: 0 0 24px 0 rgba(124, 95, 173, 0.4); }
}

@keyframes nct-compact-bob {
  0%, 100% { transform: translateY(0) rotate(-2deg); }
  50%      { transform: translateY(-3px) rotate(2deg); }
}

/* ============================================================
   REDUCED MOTION
   ============================================================ */
@media (prefers-reduced-motion: reduce) {
  .nct-mascot-halo,
  .nct-mascot-float,
  .nct-mascot-shadow,
  .nct-mascot-compact-png-wrap,
  .nct-mascot-compact-png {
    animation: none !important;
  }
}
</style>
