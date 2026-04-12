// ================================================================
//  AUTH UI
// ================================================================

let _authMode = 'signin'; // 'signin' | 'signup'

/** Show or hide the Sign In / account badge based on session state. */
function _updateAccountUI(session) {
  const loggedIn = !!session;
  get('accountBadge').classList.toggle('hidden', !loggedIn);
  get('signInBtn').classList.toggle('hidden', loggedIn);
  if (session) {
    get('accountEmail').textContent = session.user.email;
  } else {
    // Clear the verified label on sign-out
    const lbl = get('lastVerifiedLabel');
    if (lbl) { lbl.textContent = ''; lbl.classList.add('hidden'); }
  }
}

/**
 * Update the subtle "Last verified" label in the account badge.
 * Only visible when offline — confirms to the user that premium is still
 * active based on a cached verification, and when that verification was.
 */
function _updateVerifiedLabel() {
  const el = get('lastVerifiedLabel');
  if (!el || !Entitlement.verifiedAt) return;

  const ageMs    = Date.now() - Entitlement.verifiedAt;
  const ageDays  = Math.floor(ageMs / 86400000);
  const ageHours = Math.floor(ageMs / 3600000);
  const ageMins  = Math.floor(ageMs / 60000);

  function _ageStr() {
    if (ageDays  > 0) return ageDays  + 'd ago';
    if (ageHours > 0) return ageHours + 'h ago';
    return ageMins + 'm ago';
  }

  // Only show the label when offline — no need to surface it to online users
  const text = Entitlement.source === 'offline'
    ? 'Offline · last verified ' + _ageStr()
    : '';

  el.textContent = text;
  el.classList.toggle('hidden', text === '');
}

/** Open the auth modal in the given mode ('signin' or 'signup'). */
function _showAuthModal(mode = 'signin') {
  _setAuthMode(mode);
  _clearAuthMsg();
  get('authEmailInput').value    = '';
  get('authPasswordInput').value = '';
  get('authOverlay').classList.remove('hidden');
  setTimeout(() => get('authEmailInput').focus(), 60);
}

function _hideAuthModal() {
  get('authOverlay').classList.add('hidden');
  _clearAuthMsg();
}

function _setAuthMode(mode) {
  _authMode = mode;
  const isSignIn = mode === 'signin';
  get('authTitle').textContent        = isSignIn ? 'Sign In' : 'Create Account';
  get('authSubmitBtn').textContent    = isSignIn ? 'Sign In' : 'Create Account';
  get('authToggleLabel').textContent  = isSignIn ? "Don't have an account?" : 'Already have an account?';
  get('authToggleBtn').textContent    = isSignIn ? 'Create one' : 'Sign in';
  get('authPasswordInput').autocomplete = isSignIn ? 'current-password' : 'new-password';
}

function _showAuthMsg(text, type = 'error') {
  const el = get('authMsg');
  el.textContent = text;
  el.className   = `auth-msg ${type}`;
}

function _clearAuthMsg() {
  const el = get('authMsg');
  el.textContent = '';
  el.className   = 'auth-msg hidden';
}

async function _handleAuthSubmit() {
  if (!_supabase) return;

  const email    = get('authEmailInput').value.trim();
  const password = get('authPasswordInput').value;
  const btn      = get('authSubmitBtn');

  if (!email || !password) {
    _showAuthMsg('Please enter your email and password.');
    return;
  }

  btn.disabled    = true;
  btn.textContent = _authMode === 'signin' ? 'Signing in…' : 'Creating account…';
  _clearAuthMsg();

  try {
    let result;
    console.log('[Auth] Calling signInWithPassword...');
    if (_authMode === 'signin') {
      result = await _supabase.auth.signInWithPassword({ email, password });
    } else {
      result = await _supabase.auth.signUp({ email, password });
    }
    console.log('[Auth] signInWithPassword resolved — error:', result?.error?.message ?? 'none');

    if (result.error) {
      _showAuthMsg(result.error.message);
    } else if (_authMode === 'signup' && !result.data.session) {
      // Email confirmation required (enabled in Supabase Auth settings)
      _showAuthMsg('Check your email for a confirmation link, then sign in.', 'info');
    } else {
      console.log('[Auth] Hiding modal...');
      _hideAuthModal();
      console.log('[Auth] Modal hidden — sign-in complete.');
    }
  } catch (err) {
    _showAuthMsg(err.message || 'Something went wrong. Please try again.');
    console.error('[Auth] Sign-in error:', err.message);
  } finally {
    btn.disabled    = false;
    btn.textContent = _authMode === 'signin' ? 'Sign In' : 'Create Account';
  }
}

async function _handleSignOut() {
  if (!_supabase) return;
  // Update UI immediately — don't wait for onAuthStateChange
  _updateAccountUI(null);
  try {
    await _supabase.auth.signOut();
    console.log('[Auth] Signed out successfully.');
  } catch (err) {
    console.warn('[Auth] Sign-out error (session cleared locally anyway):', err.message);
  }
}

// ================================================================
//  ACCOUNT MANAGEMENT MODAL
// ================================================================

/** Open the account management modal and populate it with live data. */
async function _showAccountModal() {
  const { data: { session } } = await _supabase.auth.getSession();
  if (!session) return;
  get('accountModalEmail').textContent = session.user.email;
  get('passwordMsg').textContent = '';
  get('passwordMsg').classList.add('hidden');
  get('newPasswordInput').value = '';
  get('confirmPasswordInput').value = '';
  get('accountModalOverlay').classList.remove('hidden');
  await _loadDevices(session);
}

function _hideAccountModal() {
  get('accountModalOverlay').classList.add('hidden');
}

/** Fetch this user's registered devices and render the list. */
async function _loadDevices(session) {
  const list = get('devicesList');
  list.innerHTML = '<p class="acct-loading">Loading devices…</p>';
  try {
    const { data, error } = await _supabase
      .from('devices')
      .select('device_id, last_seen')
      .eq('user_id', session.user.id)
      .order('last_seen', { ascending: false });
    if (error) throw error;

    if (!data || data.length === 0) {
      list.innerHTML = '<p class="acct-loading">No devices found.</p>';
      return;
    }

    list.innerHTML = '';
    data.forEach(device => {
      const isCurrent = device.device_id === Entitlement.deviceId;
      const lastSeen  = new Date(device.last_seen);
      const ageMs     = Date.now() - lastSeen.getTime();
      const ageDays   = Math.floor(ageMs / 86400000);
      const ageHours  = Math.floor(ageMs / 3600000);
      const seenStr   = ageDays  > 0 ? `${ageDays}d ago`
                      : ageHours > 0 ? `${ageHours}h ago`
                      : 'Just now';

      const row = document.createElement('div');
      row.className = 'device-row' + (isCurrent ? ' current-device' : '');
      row.innerHTML = `
        <div class="device-info">
          <span class="device-label${isCurrent ? ' current' : ''}">
            ${isCurrent ? '● This device' : '○ Other device'}
          </span>
          <span class="device-seen">Last active ${seenStr}</span>
        </div>
        <button class="device-remove-btn" data-device-id="${device.device_id}">
          Remove
        </button>`;
      list.appendChild(row);
    });

    // Wire up remove buttons
    list.querySelectorAll('.device-remove-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const deviceId = btn.dataset.deviceId;
        btn.disabled = true;
        btn.textContent = 'Removing…';
        await _removeDevice(deviceId, session);
      });
    });
  } catch (err) {
    list.innerHTML = '<p class="acct-loading">Could not load devices.</p>';
    console.error('[Account] Device load error:', err.message);
  }
}

/** Remove a device. If it's the current device, sign out afterwards. */
async function _removeDevice(deviceId, session) {
  try {
    const { error } = await _supabase
      .from('devices')
      .delete()
      .eq('user_id', session.user.id)
      .eq('device_id', deviceId);
    if (error) throw error;

    const isCurrent = deviceId === Entitlement.deviceId;
    if (isCurrent) {
      // Removed own device — sign out
      _hideAccountModal();
      await _handleSignOut();
    } else {
      // Refresh the list
      await _loadDevices(session);
    }
  } catch (err) {
    console.error('[Account] Remove device error:', err.message);
    // Reload to reset button state
    await _loadDevices(session);
  }
}

/** Change the authenticated user's password. */
async function _changePassword() {
  const newPw  = get('newPasswordInput').value;
  const confPw = get('confirmPasswordInput').value;
  const msg    = get('passwordMsg');
  const btn    = get('changePasswordBtn');

  const showMsg = (text, isError = true) => {
    msg.textContent = text;
    msg.className   = 'auth-msg' + (isError ? '' : ' info');
  };

  if (!newPw || newPw.length < 6) {
    showMsg('Password must be at least 6 characters.');
    msg.classList.remove('hidden');
    return;
  }
  if (newPw !== confPw) {
    showMsg('Passwords do not match.');
    msg.classList.remove('hidden');
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Updating…';
  msg.classList.add('hidden');

  try {
    const { error } = await _supabase.auth.updateUser({ password: newPw });
    if (error) throw error;
    get('newPasswordInput').value    = '';
    get('confirmPasswordInput').value = '';
    showMsg('Password updated successfully.', false);
    msg.classList.remove('hidden');
  } catch (err) {
    showMsg(err.message || 'Could not update password. Please try again.');
    msg.classList.remove('hidden');
    console.error('[Account] Password change error:', err.message);
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Update Password';
  }
}
