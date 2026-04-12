'use strict';

// ================================================================
//  SUPABASE CONFIG  (Phase 2)
//  Fill these in after completing the Supabase dashboard setup:
//    Project Settings → API → Project URL  &  anon/public key
//  The anon key is safe to ship in frontend code — it is access-controlled
//  by Row-Level Security policies (added in Phase 3+).
// ================================================================
const SUPABASE_URL      = 'https://spagrpqdisiebxxuyyvq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_wqYKdFLQLN3grMz28O2vUQ_bjkgNdnk';

// Supabase JS client — falls back to null if the SDK CDN script failed to load
// (e.g. completely offline on first visit).
const _supabase = (typeof supabase !== 'undefined' && !SUPABASE_URL.includes('YOUR_PROJECT_REF'))
  ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

// ================================================================
//  DEV OVERRIDE
//  Set true locally to force premium features on without a backend.
//  Must be false before any public deployment.
// ================================================================
const DEV_OVERRIDE = false;

// ================================================================
//  HELPERS
// ================================================================
const get = id  => document.getElementById(id);
const qsa = sel => [...document.querySelectorAll(sel)];
