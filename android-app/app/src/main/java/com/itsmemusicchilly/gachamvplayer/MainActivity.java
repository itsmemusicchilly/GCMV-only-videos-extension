package com.itsmemusicchilly.gachamvplayer;

import android.annotation.SuppressLint;
import android.app.Dialog;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.net.Uri;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;

import com.google.android.material.bottomsheet.BottomSheetBehavior;
import com.google.android.material.bottomsheet.BottomSheetDialog;
import com.google.android.material.button.MaterialButton;
import com.google.android.material.floatingactionbutton.FloatingActionButton;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.json.JSONObject;
import org.json.JSONTokener;

public class MainActivity extends AppCompatActivity {

    private static final String TAG = "GachaMVPlayer";
    private static final String YOUTUBE_URL = "https://m.youtube.com";
    private static final String USER_AGENT = "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";

    private WebView webView;
    private FrameLayout customViewContainer;
    private ProgressBar progressBar;
    private LinearLayout topBar;
    private FloatingActionButton fabSettings;
    private View btnSettings;
    private View btnJukebox;
    private View btnSkips;
    private ImageButton btnReload;

    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private boolean wasFullscreenBeforeNavigate = false;

    private String polyfillJs = "";
    private String contentCss = "";
    private String contentJs = "";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private BottomSheetDialog settingsDialog = null;
    private RemoteServerManager remoteServerManager = null;

    @SuppressLint({"SetJavaScriptEnabled", "ClickableViewAccessibility"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.web_view);
        customViewContainer = findViewById(R.id.custom_view_container);
        progressBar = findViewById(R.id.progress_bar);
        topBar = findViewById(R.id.top_bar);
        fabSettings = findViewById(R.id.fab_settings);
        btnSettings = findViewById(R.id.btn_settings);
        btnJukebox = findViewById(R.id.btn_jukebox);
        btnSkips = findViewById(R.id.btn_skips);
        btnReload = findViewById(R.id.btn_reload);

        loadExtensionAssets();
        setupTopBarAndFab();
        setupWebView();
        setupRemoteServer();
        setupBackNavigation();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(YOUTUBE_URL);
        }
    }

    private void setupRemoteServer() {
        remoteServerManager = new RemoteServerManager(this);
        remoteServerManager.setListener(new RemoteServerManager.RemoteActionListener() {
            @Override
            public void onPlayNow(String videoId, String title) {
                if (webView != null) {
                    if (customView != null) {
                        wasFullscreenBeforeNavigate = true;
                    }
                    webView.loadUrl("https://m.youtube.com/watch?v=" + videoId);
                }
            }

            @Override
            public void onControlAction(String action, Object value) {
                if (webView == null || action == null) return;
                switch (action) {
                    case "play":
                        webView.evaluateJavascript("(function(){ var v=document.querySelector('video'); if(v) v.play(); })()", null);
                        break;
                    case "pause":
                        webView.evaluateJavascript("(function(){ var v=document.querySelector('video'); if(v) v.pause(); })()", null);
                        break;
                    case "next":
                        if (customView != null) {
                            wasFullscreenBeforeNavigate = true;
                        }
                        webView.evaluateJavascript("(function(){ if(typeof window.__gachaForceSkip==='function'){ window.__gachaForceSkip('remote_skip'); } else if(typeof window.__gachaSkipVideo==='function'){ window.__gachaSkipVideo('remote_skip'); } else { var btn=document.querySelector('.ytp-next-button, [data-testid=\"next-button\"], .player-controls-next, .icon-button.player-control-next, ytm-next-button'); if(btn) btn.click(); } })()", null);
                        break;
                    case "volume":
                        if (value instanceof Number) {
                            int vol = Math.max(0, Math.min(200, ((Number) value).intValue()));
                            webView.evaluateJavascript("(function(){ var v=document.querySelector('video'); if(v) v.volume = " + (Math.min(100, vol) / 100.0) + "; })()", null);
                        }
                        break;
                }
            }
        });

        boolean remoteEnabled = getSharedPreferences("gacha_prefs", MODE_PRIVATE).getBoolean("remoteServerEnabled", true);
        if (remoteEnabled) {
            remoteServerManager.start(8080);
        }
    }

    private void setupTopBarAndFab() {
        if (btnSettings != null) {
            btnSettings.setOnClickListener(v -> showNativeSettingsModal());
        }

        if (btnJukebox != null) {
            btnJukebox.setOnClickListener(v -> showNativeJukeboxModal());
        }

        if (btnSkips != null) {
            btnSkips.setOnClickListener(v -> showNativeSkipsModal());
        }

        if (btnReload != null) {
            btnReload.setOnClickListener(v -> {
                if (webView != null) webView.reload();
            });
        }

        if (fabSettings != null) {
            fabSettings.setOnClickListener(v -> showNativeSettingsModal());
        }
    }

    /**
     * Attempts to open the in-page Gacha Settings drawer; falls back to the native Popup modal dialog.
     */
    public void openExtensionSettings() {
        if (webView == null) {
            showNativeSettingsModal();
            return;
        }

        webView.evaluateJavascript(
            "(function() {\n" +
            "  if (typeof window.__gachaOpenSettings === 'function') {\n" +
            "    window.__gachaOpenSettings();\n" +
            "    return true;\n" +
            "  }\n" +
            "  return false;\n" +
            "})();",
            value -> {
                if (!"true".equals(value)) {
                    showNativeSettingsModal();
                }
            }
        );
    }

    /**
     * Opens the Jukebox Streams / Instant Radio tab in-page, or native modal fallback.
     */
    public void openExtensionJukebox() {
        if (webView == null) {
            showNativeJukeboxModal();
            return;
        }
        webView.evaluateJavascript(
            "(function() {\n" +
            "  if (typeof window.__gachaOpenJukebox === 'function') {\n" +
            "    window.__gachaOpenJukebox();\n" +
            "    return true;\n" +
            "  }\n" +
            "  return false;\n" +
            "})();",
            value -> {
                if (!"true".equals(value)) {
                    showNativeJukeboxModal();
                }
            }
        );
    }

    /**
     * Opens the Video Skips, SponsorBlock segments, and POI Highlights tab in-page, or native modal fallback.
     */
    public void openExtensionSkipList() {
        if (webView == null) {
            showNativeSkipsModal();
            return;
        }
        webView.evaluateJavascript(
            "(function() {\n" +
            "  if (typeof window.__gachaOpenSkipList === 'function') {\n" +
            "    window.__gachaOpenSkipList();\n" +
            "    return true;\n" +
            "  }\n" +
            "  return false;\n" +
            "})();",
            value -> {
                if (!"true".equals(value)) {
                    showNativeSkipsModal();
                }
            }
        );
    }

    /**
     * Shows the native Material Settings BottomSheet dialog.
     */
    public void showNativeSettingsModal() {
        if (isFinishing() || isDestroyed()) return;

        if (settingsDialog != null && settingsDialog.isShowing()) {
            settingsDialog.dismiss();
        }

        settingsDialog = new BottomSheetDialog(this);
        View view = getLayoutInflater().inflate(R.layout.dialog_settings, null);
        settingsDialog.setContentView(view);

        com.google.android.material.switchmaterial.SwitchMaterial swMaster = view.findViewById(R.id.switch_master);
        com.google.android.material.switchmaterial.SwitchMaterial swJukebox = view.findViewById(R.id.switch_jukebox);
        com.google.android.material.switchmaterial.SwitchMaterial swChips = view.findViewById(R.id.switch_searchchips);
        com.google.android.material.switchmaterial.SwitchMaterial swAdBlock = view.findViewById(R.id.switch_adblock);
        com.google.android.material.switchmaterial.SwitchMaterial swAutoSkip = view.findViewById(R.id.switch_autoskip);
        com.google.android.material.switchmaterial.SwitchMaterial swGuard = view.findViewById(R.id.switch_autoplayguard);
        com.google.android.material.switchmaterial.SwitchMaterial swAutoUnmute = view.findViewById(R.id.switch_auto_unmute);
        com.google.android.material.switchmaterial.SwitchMaterial swSmooth = view.findViewById(R.id.switch_smooth_playback);
        com.google.android.material.switchmaterial.SwitchMaterial swFilterOfficial = view.findViewById(R.id.switch_filter_official);
        com.google.android.material.switchmaterial.SwitchMaterial swSkipNonMusic = view.findViewById(R.id.switch_skip_nonmusic);
        com.google.android.material.switchmaterial.SwitchMaterial swSkipIntroOutro = view.findViewById(R.id.switch_skip_introoutro);
        com.google.android.material.switchmaterial.SwitchMaterial swSkipSponsor = view.findViewById(R.id.switch_skip_sponsor);
        com.google.android.material.switchmaterial.SwitchMaterial swPoi = view.findViewById(R.id.switch_poi_highlights);
        com.google.android.material.switchmaterial.SwitchMaterial swSponsorBlock = view.findViewById(R.id.switch_sponsorblock);
        com.google.android.material.switchmaterial.SwitchMaterial swCustomDb = view.findViewById(R.id.switch_custom_db);
        com.google.android.material.switchmaterial.SwitchMaterial swNas = view.findViewById(R.id.switch_nas);

        LinearLayout layoutNasDetails = view.findViewById(R.id.layout_nas_details);
        EditText etNasUrl = view.findViewById(R.id.et_nas_url);
        EditText etNasToken = view.findViewById(R.id.et_nas_token);
        View btnNasTest = view.findViewById(R.id.btn_nas_test);
        TextView tvNasStatus = view.findViewById(R.id.tv_nas_status);
        com.google.android.material.switchmaterial.SwitchMaterial swNasAutoSync = view.findViewById(R.id.switch_nas_autosync);
        View btnNasExport = view.findViewById(R.id.btn_nas_export);
        View btnNasImport = view.findViewById(R.id.btn_nas_import);

        com.google.android.material.switchmaterial.SwitchMaterial swRemote = view.findViewById(R.id.switch_remote_server);
        LinearLayout layoutRemoteDetails = view.findViewById(R.id.layout_remote_details);
        TextView tvRemoteUrl = view.findViewById(R.id.tv_remote_server_url);
        View btnCopyRemoteUrl = view.findViewById(R.id.btn_copy_remote_url);
        com.google.android.material.switchmaterial.SwitchMaterial swRemotePin = view.findViewById(R.id.switch_remote_pin);
        LinearLayout layoutPinInput = view.findViewById(R.id.layout_pin_input);
        EditText etRemotePin = view.findViewById(R.id.et_remote_pin);

        com.google.android.material.slider.Slider slVolume = view.findViewById(R.id.slider_volume);
        TextView tvVol = view.findViewById(R.id.tv_volume_val);
        TextView tvBadge = view.findViewById(R.id.tv_status_badge);
        View btnReset = view.findViewById(R.id.btn_reset_whitelist);

        android.content.SharedPreferences sp = getSharedPreferences("gacha_prefs", MODE_PRIVATE);
        boolean enabled = sp.getBoolean("enabled", true);
        boolean jukebox = sp.getBoolean("showJukebox", true);
        boolean chips = sp.getBoolean("showSearchChips", true);
        boolean blockAds = sp.getBoolean("blockAds", true);
        boolean autoSkip = sp.getBoolean("autoSkipNonGacha", true);
        boolean guard = sp.getBoolean("autoplayGuard", true);
        boolean autoUnmute = sp.getBoolean("autoUnmute", true);
        boolean smoothPlayback = sp.getBoolean("smoothPlayback", true);
        boolean filterOfficial = sp.getBoolean("filterOfficialVideos", true);
        boolean skipNonMusic = sp.getBoolean("skipNonMusic", true);
        boolean skipIntroOutro = sp.getBoolean("skipIntroOutro", true);
        boolean skipSponsor = sp.getBoolean("skipSponsor", true);
        boolean showPoi = sp.getBoolean("showPoiHighlights", true);
        boolean sbApi = sp.getBoolean("useSponsorBlockApi", true);
        boolean customDb = sp.getBoolean("useCustomDb", true);
        boolean useNas = sp.getBoolean("useNasServer", false);
        String nasUrl = sp.getString("nasServerUrl", "");
        String nasToken = sp.getString("nasAuthToken", "");
        boolean nasAutoSync = sp.getBoolean("nasAutoSync", false);
        boolean remoteEnabled = sp.getBoolean("remoteServerEnabled", true);
        boolean remotePinEnabled = sp.getBoolean("remotePinEnabled", false);
        String remotePin = sp.getString("remotePin", "1234");
        float boost = sp.getFloat("volumeBoost", 100f);

        if (swMaster != null) swMaster.setChecked(enabled);
        if (swJukebox != null) swJukebox.setChecked(jukebox);
        if (swChips != null) swChips.setChecked(chips);
        if (swAdBlock != null) swAdBlock.setChecked(blockAds);
        if (swAutoSkip != null) swAutoSkip.setChecked(autoSkip);
        if (swGuard != null) swGuard.setChecked(guard);
        if (swAutoUnmute != null) swAutoUnmute.setChecked(autoUnmute);
        if (swSmooth != null) swSmooth.setChecked(smoothPlayback);
        if (swFilterOfficial != null) swFilterOfficial.setChecked(filterOfficial);
        if (swSkipNonMusic != null) swSkipNonMusic.setChecked(skipNonMusic);
        if (swSkipIntroOutro != null) swSkipIntroOutro.setChecked(skipIntroOutro);
        if (swSkipSponsor != null) swSkipSponsor.setChecked(skipSponsor);
        if (swPoi != null) swPoi.setChecked(showPoi);
        if (swSponsorBlock != null) swSponsorBlock.setChecked(sbApi);
        if (swCustomDb != null) swCustomDb.setChecked(customDb);
        if (swNas != null) swNas.setChecked(useNas);

        if (layoutNasDetails != null) layoutNasDetails.setVisibility(useNas ? View.VISIBLE : View.GONE);
        if (etNasUrl != null) etNasUrl.setText(nasUrl);
        if (etNasToken != null) etNasToken.setText(nasToken);
        if (swNasAutoSync != null) swNasAutoSync.setChecked(nasAutoSync);

        ImageView ivRemoteQr = view.findViewById(R.id.iv_remote_qr);
        View layoutRemoteQr = view.findViewById(R.id.layout_remote_qr);
        android.widget.HorizontalScrollView scrollIpChips = view.findViewById(R.id.scroll_remote_ip_chips);
        LinearLayout layoutIpChips = view.findViewById(R.id.layout_remote_ip_chips);
        final String[] activeUrlHolder = new String[] { remoteServerManager != null ? remoteServerManager.getServerUrl() : "http://127.0.0.1:8080/remote" };

        Runnable refreshRemoteUi = () -> {
            if (remoteServerManager != null && remoteServerManager.isRunning()) {
                List<RemoteServerManager.NetworkAddressInfo> addrs = remoteServerManager.getAvailableIpAddresses();
                int port = remoteServerManager.getPort();

                if (layoutIpChips != null && scrollIpChips != null) {
                    layoutIpChips.removeAllViews();
                    if (addrs.size() > 1) {
                        scrollIpChips.setVisibility(View.VISIBLE);
                        for (RemoteServerManager.NetworkAddressInfo info : addrs) {
                            com.google.android.material.button.MaterialButton chip = new com.google.android.material.button.MaterialButton(this, null, com.google.android.material.R.attr.borderlessButtonStyle);
                            String icon = "tailscale".equals(info.type) ? "🔒" : "wifi".equals(info.type) ? "📶" : "ethernet".equals(info.type) ? "🌐" : "📱";
                            chip.setText(icon + " " + info.name + ": " + info.ip);
                            chip.setTextSize(11f);
                            chip.setAllCaps(false);
                            chip.setCornerRadius((int) (12 * getResources().getDisplayMetrics().density));
                            chip.setPadding(24, 8, 24, 8);
                            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                                    LinearLayout.LayoutParams.WRAP_CONTENT,
                                    (int) (32 * getResources().getDisplayMetrics().density));
                            lp.setMargins(0, 0, (int) (8 * getResources().getDisplayMetrics().density), 0);
                            chip.setLayoutParams(lp);

                            boolean isCurrent = activeUrlHolder[0].contains(info.ip);
                            chip.setBackgroundTintList(android.content.res.ColorStateList.valueOf(isCurrent ? 0xFF6B21A8 : 0xFF211A3E));
                            chip.setTextColor(isCurrent ? 0xFF00FFAA : 0xFFC5C0D8);

                            chip.setOnClickListener(cv -> {
                                activeUrlHolder[0] = "http://" + info.ip + ":" + port + "/remote";
                                if (tvRemoteUrl != null) tvRemoteUrl.setText(activeUrlHolder[0]);
                                if (ivRemoteQr != null) {
                                    Bitmap bmp = QRCodeUtil.generateQrBitmap(activeUrlHolder[0], 400, 400);
                                    if (bmp != null) ivRemoteQr.setImageBitmap(bmp);
                                }
                                for (int i = 0; i < layoutIpChips.getChildCount(); i++) {
                                    View child = layoutIpChips.getChildAt(i);
                                    if (child instanceof com.google.android.material.button.MaterialButton) {
                                        boolean sel = child == cv;
                                        ((com.google.android.material.button.MaterialButton) child).setBackgroundTintList(
                                                android.content.res.ColorStateList.valueOf(sel ? 0xFF6B21A8 : 0xFF211A3E));
                                        ((com.google.android.material.button.MaterialButton) child).setTextColor(sel ? 0xFF00FFAA : 0xFFC5C0D8);
                                    }
                                }
                            });
                            layoutIpChips.addView(chip);
                        }
                    } else {
                        scrollIpChips.setVisibility(View.GONE);
                    }
                }

                if (tvRemoteUrl != null) tvRemoteUrl.setText(activeUrlHolder[0]);
                if (layoutRemoteQr != null) layoutRemoteQr.setVisibility(View.VISIBLE);
                if (ivRemoteQr != null) {
                    Bitmap bmp = QRCodeUtil.generateQrBitmap(activeUrlHolder[0], 400, 400);
                    if (bmp != null) {
                        ivRemoteQr.setImageBitmap(bmp);
                    }
                }
            } else {
                if (tvRemoteUrl != null) tvRemoteUrl.setText("Server Stopped");
                if (layoutRemoteQr != null) layoutRemoteQr.setVisibility(View.GONE);
                if (scrollIpChips != null) scrollIpChips.setVisibility(View.GONE);
            }
        };

        if (swRemote != null) swRemote.setChecked(remoteEnabled);
        if (layoutRemoteDetails != null) layoutRemoteDetails.setVisibility(remoteEnabled ? View.VISIBLE : View.GONE);
        refreshRemoteUi.run();

        View.OnClickListener copyUrlListener = v -> {
            if (remoteServerManager != null && remoteServerManager.isRunning()) {
                String url = activeUrlHolder[0];
                android.content.ClipboardManager cm = (android.content.ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                if (cm != null) {
                    cm.setPrimaryClip(android.content.ClipData.newPlainText("Remote Control URL", url));
                    Toast.makeText(this, "📋 Remote URL copied to clipboard: " + url, Toast.LENGTH_SHORT).show();
                }
            } else {
                Toast.makeText(this, "Remote server is stopped", Toast.LENGTH_SHORT).show();
            }
        };

        if (btnCopyRemoteUrl != null) btnCopyRemoteUrl.setOnClickListener(copyUrlListener);
        if (tvRemoteUrl != null) tvRemoteUrl.setOnClickListener(copyUrlListener);
        if (ivRemoteQr != null) ivRemoteQr.setOnClickListener(copyUrlListener);

        if (swRemotePin != null) swRemotePin.setChecked(remotePinEnabled);
        if (layoutPinInput != null) layoutPinInput.setVisibility(remotePinEnabled ? View.VISIBLE : View.GONE);
        if (etRemotePin != null) etRemotePin.setText(remotePin);

        if (tvBadge != null) {
            tvBadge.setText(enabled ? "ACTIVE" : "PAUSED");
            tvBadge.setTextColor(enabled ? 0xFF00FFAA : 0xFFFF4444);
        }
        if (slVolume != null) {
            slVolume.setValue(Math.max(100f, Math.min(1000f, boost)));
            if (tvVol != null) tvVol.setText(String.format("%d%% (%.1fx)", (int) boost, boost / 100f));
        }

        autoSaveSetting(swMaster, "enabled", isChecked -> {
            if (tvBadge != null) {
                tvBadge.setText(isChecked ? "ACTIVE" : "PAUSED");
                tvBadge.setTextColor(isChecked ? 0xFF00FFAA : 0xFFFF4444);
            }
        });
        autoSaveSetting(swJukebox, "showJukebox", null);
        autoSaveSetting(swChips, "showSearchChips", null);
        autoSaveSetting(swAdBlock, "blockAds", null);
        autoSaveSetting(swAutoSkip, "autoSkipNonGacha", null);
        autoSaveSetting(swGuard, "autoplayGuard", null);
        autoSaveSetting(swAutoUnmute, "autoUnmute", null);
        autoSaveSetting(swSmooth, "smoothPlayback", this::applySmoothPlayback);

        Spinner spResolution = view.findViewById(R.id.spinner_resolution);
        String[] resDisplayOptions = new String[]{"Auto", "4K (2160p)", "1440p (2K)", "1080p", "720p", "480p", "360p", "240p", "144p"};
        String[] resValueOptions = new String[]{"auto", "2160p", "1440p", "1080p", "720p", "480p", "360p", "240p", "144p"};
        String preferredRes = sp.getString("preferredResolution", "auto");

        if (spResolution != null) {
            ArrayAdapter<String> resAdapter = new ArrayAdapter<>(
                    this,
                    R.layout.item_spinner_resolution,
                    resDisplayOptions
            );
            resAdapter.setDropDownViewResource(R.layout.item_spinner_dropdown);
            spResolution.setAdapter(resAdapter);

            int selectedIndex = 0;
            for (int i = 0; i < resValueOptions.length; i++) {
                if (resValueOptions[i].equalsIgnoreCase(preferredRes)) {
                    selectedIndex = i;
                    break;
                }
            }

            final boolean[] isResFirstCall = {true};
            spResolution.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
                @Override
                public void onItemSelected(AdapterView<?> parent, View v, int position, long id) {
                    if (isResFirstCall[0]) {
                        isResFirstCall[0] = false;
                        return;
                    }
                    if (position >= 0 && position < resValueOptions.length) {
                        String chosenVal = resValueOptions[position];
                        sp.edit().putString("preferredResolution", chosenVal).apply();
                        syncSettingToWebView("preferredResolution", chosenVal);
                    }
                }

                @Override
                public void onNothingSelected(AdapterView<?> parent) {}
            });
            // Set selection AFTER attaching listener so the first-call guard is always active
            // when onItemSelected fires synchronously on some Android versions
            spResolution.setSelection(selectedIndex, false);
        }


        autoSaveSetting(swFilterOfficial, "filterOfficialVideos", null);
        autoSaveSetting(swSkipNonMusic, "skipNonMusic", null);
        autoSaveSetting(swSkipIntroOutro, "skipIntroOutro", null);
        autoSaveSetting(swSkipSponsor, "skipSponsor", null);
        autoSaveSetting(swPoi, "showPoiHighlights", null);
        autoSaveSetting(swSponsorBlock, "useSponsorBlockApi", null);
        autoSaveSetting(swCustomDb, "useCustomDb", null);
        autoSaveSetting(swNas, "useNasServer", isChecked -> {
            if (layoutNasDetails != null) layoutNasDetails.setVisibility(isChecked ? View.VISIBLE : View.GONE);
        });
        autoSaveSetting(swNasAutoSync, "nasAutoSync", null);

        autoSaveSetting(swRemote, "remoteServerEnabled", isChecked -> {
            if (layoutRemoteDetails != null) layoutRemoteDetails.setVisibility(isChecked ? View.VISIBLE : View.GONE);
            if (isChecked) {
                if (remoteServerManager != null && !remoteServerManager.isRunning()) {
                    remoteServerManager.start(8080);
                    mainHandler.postDelayed(() -> {
                        refreshRemoteUi.run();
                    }, 500);
                } else {
                    refreshRemoteUi.run();
                }
            } else {
                if (remoteServerManager != null && remoteServerManager.isRunning()) {
                    remoteServerManager.stop();
                }
                refreshRemoteUi.run();
            }
        });

        autoSaveSetting(swRemotePin, "remotePinEnabled", isChecked -> {
            if (layoutPinInput != null) layoutPinInput.setVisibility(isChecked ? View.VISIBLE : View.GONE);
        });

        if (etRemotePin != null) {
            etRemotePin.addTextChangedListener(new android.text.TextWatcher() {
                public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
                public void onTextChanged(CharSequence s, int start, int count, int after) {}
                public void afterTextChanged(android.text.Editable s) {
                    String pin = s.toString().trim();
                    sp.edit().putString("remotePin", pin).apply();
                    syncSettingToWebView("remotePin", pin);
                }
            });
        }

        if (etNasUrl != null) {
            etNasUrl.addTextChangedListener(new android.text.TextWatcher() {
                public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
                public void onTextChanged(CharSequence s, int start, int count, int after) {}
                public void afterTextChanged(android.text.Editable s) {
                    persistNasCredentials(sp, s.toString(), etNasToken != null ? etNasToken.getText().toString() : sp.getString("nasAuthToken", ""));
                }
            });
        }

        if (etNasToken != null) {
            etNasToken.addTextChangedListener(new android.text.TextWatcher() {
                public void beforeTextChanged(CharSequence s, int start, int count, int after) {}
                public void onTextChanged(CharSequence s, int start, int count, int after) {}
                public void afterTextChanged(android.text.Editable s) {
                    persistNasCredentials(sp, etNasUrl != null ? etNasUrl.getText().toString() : sp.getString("nasServerUrl", ""), s.toString());
                }
            });
        }

        settingsDialog.setOnDismissListener(dialog -> persistNasCredentials(
            sp,
            etNasUrl != null ? etNasUrl.getText().toString() : "",
            etNasToken != null ? etNasToken.getText().toString() : ""
        ));

        if (btnNasTest != null) {
            btnNasTest.setOnClickListener(v -> testNasConnection(etNasUrl, etNasToken, tvNasStatus));
        }

        if (btnNasExport != null) {
            btnNasExport.setOnClickListener(v -> exportDatabaseToNas(etNasUrl, etNasToken));
        }

        if (btnNasImport != null) {
            btnNasImport.setOnClickListener(v -> importDatabaseFromNas(etNasUrl, etNasToken));
        }

        if (slVolume != null) {
            slVolume.addOnChangeListener((slider, value, fromUser) -> {
                if (tvVol != null) tvVol.setText(String.format("%.1fx", value / 100f));
                sp.edit().putFloat("volumeBoost", value).apply();
                syncSettingToWebView("volumeBoost", (int) value);
            });
        }

        if (btnReset != null) {
            btnReset.setOnClickListener(v -> {
                syncSettingToWebView("gachaWhitelist", "{\"videoIds\":[],\"channels\":[]}");
                Toast.makeText(this, "🌸 Whitelist cleared! Filters reapplied.", Toast.LENGTH_SHORT).show();
            });
        }

        settingsDialog.show();
    }

    private void testNasConnection(EditText etUrl, EditText etToken, TextView tvStatus) {
        String rawUrl = etUrl != null ? etUrl.getText().toString().trim() : "";
        String token = etToken != null ? etToken.getText().toString().trim() : "";

        if (rawUrl.isEmpty()) {
            if (tvStatus != null) {
                tvStatus.setText("❌ Enter URL");
                tvStatus.setTextColor(0xFFFF4444);
            }
            return;
        }

        if (tvStatus != null) {
            tvStatus.setText("⏳ Testing...");
            tvStatus.setTextColor(0xFF00E5FF);
        }

        new Thread(() -> {
            try {
                String baseUrl = rawUrl.replaceAll("/+$", "");
                java.net.URL u = new java.net.URL(baseUrl + "/api/database");
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) u.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(4000);
                conn.setReadTimeout(4000);
                if (!token.isEmpty()) {
                    conn.setRequestProperty("Authorization", "Bearer " + token);
                }
                int code = conn.getResponseCode();
                if (code == 200) {
                    try (java.io.InputStream is = conn.getInputStream();
                         java.util.Scanner s = new java.util.Scanner(is).useDelimiter("\\A")) {
                        String body = s.hasNext() ? s.next() : "{}";
                        org.json.JSONObject obj = new org.json.JSONObject(body);
                        int count = obj.length();
                        mainHandler.post(() -> {
                            if (tvStatus != null) {
                                tvStatus.setText("✅ Connected (" + count + " videos)");
                                tvStatus.setTextColor(0xFF00FFAA);
                            }
                            Toast.makeText(this, "🌸 NAS Connected successfully!", Toast.LENGTH_SHORT).show();
                        });
                    }
                } else if (code == 401) {
                    mainHandler.post(() -> {
                        if (tvStatus != null) {
                            tvStatus.setText("❌ 401 Invalid Token");
                            tvStatus.setTextColor(0xFFFF4444);
                        }
                    });
                } else {
                    mainHandler.post(() -> {
                        if (tvStatus != null) {
                            tvStatus.setText("❌ HTTP " + code);
                            tvStatus.setTextColor(0xFFFF4444);
                        }
                    });
                }
                conn.disconnect();
            } catch (Exception e) {
                mainHandler.post(() -> {
                    if (tvStatus != null) {
                        tvStatus.setText("❌ " + (e.getMessage() != null ? e.getMessage() : "Error"));
                        tvStatus.setTextColor(0xFFFF4444);
                    }
                });
            }
        }).start();
    }

    private void exportDatabaseToNas(EditText etUrl, EditText etToken) {
        if (webView == null) return;
        webView.evaluateJavascript(
            "(function(){\n" +
            "  if (window.chrome && window.chrome.storage && window.chrome.storage.local) {\n" +
            "    window.chrome.storage.local.get({ customSkipDb: {} }, function(data){\n" +
            "      var db = data.customSkipDb || {};\n" +
            "      window.__gachaUploadNas ? window.__gachaUploadNas(db) : null;\n" +
            "    });\n" +
            "  }\n" +
            "})();",
            null
        );
        Toast.makeText(this, "🌸 Backing up skips to NAS...", Toast.LENGTH_SHORT).show();
    }

    private void importDatabaseFromNas(EditText etUrl, EditText etToken) {
        String rawUrl = etUrl != null ? etUrl.getText().toString().trim() : "";
        String token = etToken != null ? etToken.getText().toString().trim() : "";
        if (rawUrl.isEmpty()) {
            Toast.makeText(this, "❌ Please enter NAS Server URL", Toast.LENGTH_SHORT).show();
            return;
        }

        new Thread(() -> {
            try {
                String baseUrl = rawUrl.replaceAll("/+$", "");
                java.net.URL u = new java.net.URL(baseUrl + "/api/database");
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) u.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(5000);
                if (!token.isEmpty()) conn.setRequestProperty("Authorization", "Bearer " + token);
                int code = conn.getResponseCode();
                if (code == 200) {
                    try (java.io.InputStream is = conn.getInputStream();
                         java.util.Scanner s = new java.util.Scanner(is).useDelimiter("\\A")) {
                        String body = s.hasNext() ? s.next() : "{}";
                        mainHandler.post(() -> {
                            syncSettingToWebView("customSkipDb", body);
                            Toast.makeText(this, "📥 Database imported from NAS!", Toast.LENGTH_SHORT).show();
                        });
                    }
                } else {
                    mainHandler.post(() -> Toast.makeText(this, "❌ NAS HTTP " + code, Toast.LENGTH_SHORT).show());
                }
                conn.disconnect();
            } catch (Exception e) {
                mainHandler.post(() -> Toast.makeText(this, "❌ NAS Error: " + e.getMessage(), Toast.LENGTH_SHORT).show());
            }
        }).start();
    }

    private void autoSaveSetting(com.google.android.material.switchmaterial.SwitchMaterial sw, String key, SettingCallback callback) {
        if (sw == null) return;
        sw.setOnCheckedChangeListener((btn, isChecked) -> {
            getSharedPreferences("gacha_prefs", MODE_PRIVATE).edit().putBoolean(key, isChecked).apply();
            syncSettingToWebView(key, isChecked);
            if (callback != null) callback.onChanged(isChecked);
        });
    }

    private interface SettingCallback {
        void onChanged(boolean value);
    }

    private void persistNasCredentials(android.content.SharedPreferences sp, String rawUrl, String rawToken) {
        String url = rawUrl != null ? rawUrl.trim() : "";
        String token = rawToken != null ? rawToken.trim() : "";
        sp.edit()
            .putString("nasServerUrl", url)
            .putString("nasAuthToken", token)
            .apply();
        syncSettingToWebView("nasServerUrl", url);
        syncSettingToWebView("nasAuthToken", token);
    }

    private static final Set<String> BOOLEAN_PREF_KEYS = new HashSet<>(Arrays.asList(
            "enabled", "showJukebox", "showSearchChips", "blockAds", "autoSkipNonGacha",
            "autoplayGuard", "autoUnmute", "smoothPlayback", "filterOfficialVideos", "skipNonMusic", "skipIntroOutro",
            "skipSponsor", "showPoiHighlights", "useSponsorBlockApi", "useCustomDb",
            "useNasServer", "nasAutoSync", "remoteServerEnabled", "remotePinEnabled"
    ));

    private void applySmoothPlayback(boolean smooth) {
        if (webView != null) {
            // LAYER_TYPE_NONE prevents off-screen hardware layer double-buffering,
            // allowing hardware acceleration to render video directly to the window surface without GPU buffer stalls.
            webView.setLayerType(smooth ? View.LAYER_TYPE_NONE : View.LAYER_TYPE_HARDWARE, null);
        }
    }

    private void syncSettingToWebView(String key, Object value) {
        if (webView == null) return;
        String valStr;
        if (value instanceof String) {
            valStr = JSONObject.quote((String) value);
        } else if (value instanceof Boolean || value instanceof Number) {
            valStr = String.valueOf(value);
        } else {
            valStr = JSONObject.quote(String.valueOf(value));
        }
        String js =
            "(function() {\n" +
            "  var obj = {}; obj[" + JSONObject.quote(key) + "] = " + valStr + ";\n" +
            "  if (window.chrome && window.chrome.storage && window.chrome.storage.local) {\n" +
            "    window.chrome.storage.local.set(obj);\n" +
            "  }\n" +
            "  if (window.__gachaMvReinit) window.__gachaMvReinit();\n" +
            "})();";
        webView.evaluateJavascript(js, null);
    }

    /**
     * Shows the native Material Jukebox Streams BottomSheet dialog.
     */
    public void showNativeJukeboxModal() {
        if (isFinishing() || isDestroyed()) return;

        BottomSheetDialog dialog = new BottomSheetDialog(this);
        View view = getLayoutInflater().inflate(R.layout.dialog_jukebox, null);
        dialog.setContentView(view);

        View btnRadio = view.findViewById(R.id.btn_native_instant_radio);
        EditText etSearch = view.findViewById(R.id.et_search_gacha);
        View btnSearchGo = view.findViewById(R.id.btn_search_gacha_go);

        TextView tvQueueHeader = view.findViewById(R.id.tv_jukebox_queue_header);
        View btnClearQueue = view.findViewById(R.id.btn_jukebox_clear_queue);
        LinearLayout layoutQueueItems = view.findViewById(R.id.layout_jukebox_queue_items);

        Runnable updateQueueUi = () -> {
            if (layoutQueueItems == null || tvQueueHeader == null) return;
            layoutQueueItems.removeAllViews();
            List<RemoteServerManager.QueueItem> items = remoteServerManager != null ? remoteServerManager.getQueue() : Collections.emptyList();
            tvQueueHeader.setText("📋 Active Remote Queue (" + items.size() + ")");
            if (items.isEmpty()) {
                TextView emptyTv = new TextView(this);
                emptyTv.setText("No queued videos. Send one from your phone!");
                emptyTv.setTextColor(0xFF8E88B0);
                emptyTv.setTextSize(11f);
                emptyTv.setPadding(4, 8, 4, 8);
                layoutQueueItems.addView(emptyTv);
            } else {
                for (int i = 0; i < items.size(); i++) {
                    final RemoteServerManager.QueueItem item = items.get(i);
                    final int pos = i + 1;
                    LinearLayout itemRow = new LinearLayout(this);
                    itemRow.setOrientation(LinearLayout.HORIZONTAL);
                    itemRow.setGravity(android.view.Gravity.CENTER_VERTICAL);
                    itemRow.setPadding(0, 8, 0, 8);

                    TextView titleTv = new TextView(this);
                    LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
                    titleTv.setLayoutParams(titleLp);
                    titleTv.setText(pos + ". " + item.title);
                    titleTv.setTextColor(0xFFFFFFFF);
                    titleTv.setTextSize(12f);
                    titleTv.setMaxLines(1);
                    titleTv.setEllipsize(android.text.TextUtils.TruncateAt.END);
                    itemRow.addView(titleTv);

                    TextView playNowBtn = new TextView(this);
                    playNowBtn.setText("▶ Play");
                    playNowBtn.setTextColor(0xFF00FFAA);
                    playNowBtn.setTextSize(11f);
                    playNowBtn.setPadding(12, 4, 12, 4);
                    playNowBtn.setOnClickListener(v -> {
                        if (remoteServerManager != null) {
                            remoteServerManager.removeQueueItem(item.id);
                        }
                        dialog.dismiss();
                        if (webView != null) webView.loadUrl("https://m.youtube.com/watch?v=" + item.videoId);
                    });
                    itemRow.addView(playNowBtn);

                    TextView delBtn = new TextView(this);
                    delBtn.setText("✕");
                    delBtn.setTextColor(0xFFFF4444);
                    delBtn.setTextSize(13f);
                    delBtn.setPadding(8, 4, 8, 4);
                    delBtn.setOnClickListener(v -> {
                        if (remoteServerManager != null) {
                            remoteServerManager.removeQueueItem(item.id);
                        }
                        layoutQueueItems.removeView(itemRow);
                        int count = remoteServerManager != null ? remoteServerManager.getQueue().size() : 0;
                        tvQueueHeader.setText("📋 Active Remote Queue (" + count + ")");
                    });
                    itemRow.addView(delBtn);

                    layoutQueueItems.addView(itemRow);
                }
            }
        };

        updateQueueUi.run();

        if (btnClearQueue != null) {
            btnClearQueue.setOnClickListener(v -> {
                if (remoteServerManager != null) {
                    remoteServerManager.clearQueue();
                }
                updateQueueUi.run();
                Toast.makeText(this, "Active queue cleared", Toast.LENGTH_SHORT).show();
            });
        }

        if (btnRadio != null) {
            btnRadio.setOnClickListener(v -> {
                dialog.dismiss();
                if (webView != null) webView.loadUrl("https://m.youtube.com/results?search_query=Trending+GCMV+GLMV");
            });
        }

        Runnable doSearch = () -> {
            if (etSearch != null && etSearch.getText() != null) {
                String q = etSearch.getText().toString().trim();
                if (!q.isEmpty()) {
                    dialog.dismiss();
                    if (webView != null) webView.loadUrl("https://m.youtube.com/results?search_query=" + Uri.encode(q + " GCMV GLMV"));
                }
            }
        };

        if (btnSearchGo != null) btnSearchGo.setOnClickListener(v -> doSearch.run());
        if (etSearch != null) {
            etSearch.setOnEditorActionListener((v, actionId, event) -> {
                doSearch.run();
                return true;
            });
        }

        bindCategoryButton(view, R.id.cat_gcmv, "GCMV Club Music Videos", dialog);
        bindCategoryButton(view, R.id.cat_glmv, "GLMV Gacha Life Classic Hits", dialog);
        bindCategoryButton(view, R.id.cat_glmv2, "GLMV2 Gacha Life 2", dialog);
        bindCategoryButton(view, R.id.cat_lyrics, "Gacha Lyric Videos", dialog);
        bindCategoryButton(view, R.id.cat_emotional, "Gacha Emotional Sad Story MV", dialog);
        bindCategoryButton(view, R.id.cat_upbeat, "Upbeat Pop Nightcore GCMV", dialog);

        dialog.show();
    }

    private void bindCategoryButton(View root, int btnId, String query, BottomSheetDialog dialog) {
        View b = root.findViewById(btnId);
        if (b != null) {
            b.setOnClickListener(v -> {
                dialog.dismiss();
                if (webView != null) webView.loadUrl("https://m.youtube.com/results?search_query=" + Uri.encode(query));
            });
        }
    }

    /**
     * Shows the native Material Skips & Highlights BottomSheet dialog.
     */
    public void showNativeSkipsModal() {
        if (isFinishing() || isDestroyed()) return;

        BottomSheetDialog dialog = new BottomSheetDialog(this);
        View view = getLayoutInflater().inflate(R.layout.dialog_skips, null);
        dialog.setContentView(view);

        View btnJump = view.findViewById(R.id.btn_native_jump_drop);
        if (btnJump != null) {
            btnJump.setOnClickListener(v -> {
                dialog.dismiss();
                if (webView != null) {
                    webView.evaluateJavascript("(function(){ if (window.__gachaJumpPoi) window.__gachaJumpPoi(); })();", null);
                }
            });
        }

        com.google.android.material.switchmaterial.SwitchMaterial swNonMusic = view.findViewById(R.id.switch_skip_nonmusic);
        com.google.android.material.switchmaterial.SwitchMaterial swIntro = view.findViewById(R.id.switch_skip_introoutro);
        com.google.android.material.switchmaterial.SwitchMaterial swSponsor = view.findViewById(R.id.switch_skip_sponsor);

        android.content.SharedPreferences sp = getSharedPreferences("gacha_prefs", MODE_PRIVATE);
        if (swNonMusic != null) swNonMusic.setChecked(sp.getBoolean("skipNonMusic", true));
        if (swIntro != null) swIntro.setChecked(sp.getBoolean("skipIntroOutro", true));
        if (swSponsor != null) swSponsor.setChecked(sp.getBoolean("skipSponsor", true));

        autoSaveSetting(swNonMusic, "skipNonMusic", null);
        autoSaveSetting(swIntro, "skipIntroOutro", null);
        autoSaveSetting(swSponsor, "skipSponsor", null);

        dialog.show();
    }

    private void loadExtensionAssets() {
        try {
            polyfillJs = readAssetFile("extension/chrome_polyfill.js");
            contentCss = readAssetFile("extension/content.css");
            contentJs = readAssetFile("extension/content.js");
            Log.d(TAG, "Extension assets loaded. CSS len=" + contentCss.length() + ", JS len=" + contentJs.length());
        } catch (Exception e) {
            Log.e(TAG, "Error loading extension assets", e);
        }
    }

    private String readAssetFile(String path) {
        try (InputStream is = getAssets().open(path);
             ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int length;
            while ((length = is.read(buffer)) != -1) {
                baos.write(buffer, 0, length);
            }
            return baos.toString(StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            Log.e(TAG, "Failed reading asset: " + path, e);
            return "";
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadsImagesAutomatically(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUserAgentString(USER_AGENT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        boolean smoothPlayback = getSharedPreferences("gacha_prefs", MODE_PRIVATE).getBoolean("smoothPlayback", true);
        applySmoothPlayback(smoothPlayback);
        webView.setKeepScreenOn(true);

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (newProgress < 100) {
                    progressBar.setVisibility(View.VISIBLE);
                    progressBar.setProgress(newProgress);
                } else {
                    progressBar.setVisibility(View.GONE);
                }
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                Log.d("GCMV_JS", consoleMessage.message() + " -- From line "
                        + consoleMessage.lineNumber() + " of "
                        + consoleMessage.sourceId());
                return true;
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }

                customView = view;
                customViewCallback = callback;

                if (topBar != null) topBar.setVisibility(View.GONE);
                if (fabSettings != null) fabSettings.setVisibility(View.GONE);
                webView.setVisibility(View.GONE);

                customViewContainer.setVisibility(View.VISIBLE);
                customViewContainer.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                ));

                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                enterImmersiveMode();
            }

            @Override
            public void onHideCustomView() {
                closeFullscreenCustomView();
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.contains("youtube.com") || url.contains("youtu.be") || url.contains("sponsor.ajay.app")) {
                    return false;
                }
                return false;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                // Inject early background playback hook
                injectBackgroundShim(view);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                injectExtension(view);
                scheduleDelayedInjections(view);
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                super.doUpdateVisitedHistory(view, url, isReload);
                scheduleDelayedInjections(view);
            }
        });
    }

    private void closeFullscreenCustomView() {
        if (customView == null) return;

        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        exitImmersiveMode();

        customViewContainer.removeView(customView);
        customViewContainer.setVisibility(View.GONE);

        webView.setVisibility(View.VISIBLE);
        if (topBar != null) topBar.setVisibility(View.VISIBLE);
        if (fabSettings != null) fabSettings.setVisibility(View.GONE);

        if (customViewCallback != null) {
            customViewCallback.onCustomViewHidden();
        }

        customView = null;
        customViewCallback = null;
    }

    private void injectBackgroundShim(WebView view) {
        if (view == null) return;
        boolean smooth = getSharedPreferences("gacha_prefs", MODE_PRIVATE).getBoolean("smoothPlayback", true);
        String backgroundPlayShim =
            "(function() {\n" +
            "  if (window.__GCMV_BG_SHIM_LOADED__) return;\n" +
            "  window.__GCMV_BG_SHIM_LOADED__ = true;\n" +
            "  try {\n" +
            "    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });\n" +
            "    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });\n" +
            "    Object.defineProperty(document, 'webkitVisibilityState', { get: () => 'visible', configurable: true });\n" +
            "    document.addEventListener('visibilitychange', function(e) { e.stopImmediatePropagation(); }, true);\n" +
            "    window.addEventListener('visibilitychange', function(e) { e.stopImmediatePropagation(); }, true);\n" +
            "  } catch(e) { console.warn('[GCMV] BG Shim err:', e);\n" +
            "  }\n" +
            (smooth ?
            "  try {\n" +
            "    if (window.MediaSource && typeof window.MediaSource.isTypeSupported === 'function') {\n" +
            "      var origIsTypeSupported = window.MediaSource.isTypeSupported.bind(window.MediaSource);\n" +
            "      window.MediaSource.isTypeSupported = function(type) {\n" +
            "        if (typeof type === 'string' && /av01|av1/i.test(type)) return false;\n" +
            "        return origIsTypeSupported(type);\n" +
            "      };\n" +
            "    }\n" +
            "    if (window.HTMLMediaElement && window.HTMLMediaElement.prototype && typeof window.HTMLMediaElement.prototype.canPlayType === 'function') {\n" +
            "      var origCanPlay = window.HTMLMediaElement.prototype.canPlayType;\n" +
            "      window.HTMLMediaElement.prototype.canPlayType = function(type) {\n" +
            "        if (typeof type === 'string' && /av01|av1/i.test(type)) return '';\n" +
            "        return origCanPlay.call(this, type);\n" +
            "      };\n" +
            "    }\n" +
            "  } catch(e) { console.warn('[GCMV] Early codec shim err:', e); }\n"
            : "") +
            "})();\n";
        view.evaluateJavascript(backgroundPlayShim, null);
    }

    private void injectExtension(WebView view) {
        if (view == null) return;

        // 1. Background Playback Shim
        injectBackgroundShim(view);

        // 2. Inject Polyfill
        if (polyfillJs != null && !polyfillJs.isEmpty()) {
            view.evaluateJavascript(polyfillJs, null);
        }

        // 3. Inject CSS
        if (contentCss != null && !contentCss.isEmpty()) {
            String encodedCss = Base64.encodeToString(contentCss.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
            String injectCssScript =
                "(function() {\n" +
                "  var id = 'gacha-mv-player-injected-style';\n" +
                "  var existing = document.getElementById(id);\n" +
                "  if (!existing) {\n" +
                "    var style = document.createElement('style');\n" +
                "    style.id = id;\n" +
                "    style.type = 'text/css';\n" +
                "    style.textContent = atob('" + encodedCss + "');\n" +
                "    (document.head || document.documentElement).appendChild(style);\n" +
                "  }\n" +
                "})();";
            view.evaluateJavascript(injectCssScript, null);
        }

        // 4. Inject Content Script
        if (contentJs != null && !contentJs.isEmpty()) {
            view.evaluateJavascript(contentJs, null);
        }

        // 5. Hook SPA YouTube page transitions
        String spaHook =
            "(function() {\n" +
            "  if (window.__GCMV_SPA_HOOKED__) return;\n" +
            "  window.__GCMV_SPA_HOOKED__ = true;\n" +
            "  ['yt-navigate-finish', 'spfdone', 'popstate', 'hashchange'].forEach(function(evt) {\n" +
            "    window.addEventListener(evt, function() {\n" +
            "      setTimeout(function() {\n" +
            "        if (window.__gachaMvReinit) { window.__gachaMvReinit(); }\n" +
            "      }, 300);\n" +
            "    });\n" +
            "  });\n" +
            "})();";
        view.evaluateJavascript(spaHook, null);
    }

    private void scheduleDelayedInjections(WebView view) {
        int[] delays = {300, 800, 1500, 3000};
        for (int d : delays) {
            mainHandler.postDelayed(() -> {
                if (view != null) {
                    injectExtension(view);
                    view.evaluateJavascript(
                        "(function() {\n" +
                        "  if (window.__gachaMvReinit) window.__gachaMvReinit();\n" +
                        "})();",
                        null
                    );
                    // Auto-play recovery: if the video is paused and the user did not manually pause it,
                    // tap the play button so the next song auto-starts cleanly
                    view.evaluateJavascript(
                        "(function() {\n" +
                        "  try {\n" +
                        "    var vid = document.querySelector('video.html5-main-video') || document.querySelector('video');\n" +
                        "    if (!vid || !vid.paused || vid.ended || vid.readyState < 2) return;\n" +
                        "    // Only auto-play on watch pages\n" +
                        "    if (!window.location.pathname.startsWith('/watch') && !window.location.pathname.startsWith('/shorts')) return;\n" +
                        "    // Don't interfere if user manually paused (respect existing flag in content.js)\n" +
                        "    if (window.__gachaUserManuallyPaused) return;\n" +
                        "    vid.play().catch(function() {\n" +
                        "      // Fallback: tap the player play button\n" +
                        "      var btn = document.querySelector('.ytp-play-button, .player-controls-play-pause, [data-testid=\"play-button\"]');\n" +
                        "      if (btn) btn.click();\n" +
                        "    });\n" +
                        "  } catch(e) {}\n" +
                        "})();",
                        null
                    );
                }
            }, d);
        }

        if (wasFullscreenBeforeNavigate) {
            wasFullscreenBeforeNavigate = false;
            view.evaluateJavascript(
                "(function(){\n" +
                "  try { sessionStorage.setItem('gcmv_restore_fullscreen', 'true'); } catch(e){}\n" +
                "  var attempts = 0;\n" +
                "  var t = setInterval(function(){\n" +
                "    attempts++;\n" +
                "    var btn = document.querySelector('.fullscreen-icon, button.fullscreen-icon, button[aria-label=\"Full screen\"], button[aria-label=\"fullscreen\"], .ytp-fullscreen-button, .player-control-fullscreen');\n" +
                "    var v = document.querySelector('video');\n" +
                "    if (btn && typeof btn.click === 'function') { btn.click(); clearInterval(t); }\n" +
                "    else if (v && v.requestFullscreen) { v.requestFullscreen().catch(function(){}); clearInterval(t); }\n" +
                "    else if (attempts > 30) { clearInterval(t); }\n" +
                "  }, 350);\n" +
                "})()", null);
        }
    }

    private void setupBackNavigation() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (settingsDialog != null && settingsDialog.isShowing()) {
                    settingsDialog.dismiss();
                } else if (customView != null) {
                    // Exit fullscreen video
                    closeFullscreenCustomView();
                } else if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });
    }

    private void enterImmersiveMode() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            );
        }
    }

    private void exitImmersiveMode() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Maintain uninterrupted background audio playback while switching apps
    }

    @Override
    protected void onDestroy() {
        if (settingsDialog != null && settingsDialog.isShowing()) {
            settingsDialog.dismiss();
        }
        if (remoteServerManager != null) {
            remoteServerManager.stop();
        }
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    /**
     * Native JavaScript Interface Bridge
     */
    public class AndroidBridge {
        @JavascriptInterface
        public boolean isFullscreen() {
            return customView != null;
        }

        @JavascriptInterface
        public void loadUrl(String url) {
            mainHandler.post(() -> {
                if (settingsDialog != null && settingsDialog.isShowing()) {
                    settingsDialog.dismiss();
                }
                if (webView != null && url != null && !url.isEmpty()) {
                    webView.loadUrl(url);
                }
            });
        }

        @JavascriptInterface
        public void openSettings() {
            mainHandler.post(MainActivity.this::openExtensionSettings);
        }

        @JavascriptInterface
        public void openJukebox() {
            mainHandler.post(MainActivity.this::openExtensionJukebox);
        }

        @JavascriptInterface
        public void openSkipList() {
            mainHandler.post(MainActivity.this::openExtensionSkipList);
        }

        @JavascriptInterface
        public void showNativeSettings() {
            mainHandler.post(MainActivity.this::showNativeSettingsModal);
        }

        @JavascriptInterface
        public void onTabMessage(String msgJson) {
            Log.d(TAG, "Bridge received tab message: " + msgJson);
        }

        @JavascriptInterface
        public String getAllPrefs() {
            JSONObject obj = new JSONObject();
            try {
                Map<String, ?> all = getSharedPreferences("gacha_prefs", MODE_PRIVATE).getAll();
                for (Map.Entry<String, ?> entry : all.entrySet()) {
                    Object value = entry.getValue();
                    if (value instanceof Boolean || value instanceof Integer || value instanceof Long || value instanceof Double) {
                        obj.put(entry.getKey(), value);
                    } else if (value instanceof Float) {
                        obj.put(entry.getKey(), ((Float) value).doubleValue());
                    } else if (value instanceof String) {
                        String raw = (String) value;
                        if ("nasServerUrl".equals(entry.getKey()) || "nasAuthToken".equals(entry.getKey())) {
                            obj.put(entry.getKey(), raw);
                        } else {
                            try {
                                obj.put(entry.getKey(), new JSONTokener(raw).nextValue());
                            } catch (Exception parseErr) {
                                obj.put(entry.getKey(), raw);
                            }
                        }
                    } else if (value != null) {
                        obj.put(entry.getKey(), value.toString());
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "getAllPrefs failed", e);
            }
            return obj.toString();
        }

        @JavascriptInterface
        public void savePref(String key, String jsonValue) {
            if (key == null || key.isEmpty()) return;
            android.content.SharedPreferences.Editor editor = getSharedPreferences("gacha_prefs", MODE_PRIVATE).edit();
            if (jsonValue == null || "null".equals(jsonValue)) {
                editor.remove(key).apply();
                return;
            }

            try {
                Object parsed = new JSONTokener(jsonValue).nextValue();
                if (BOOLEAN_PREF_KEYS.contains(key) && parsed instanceof Boolean) {
                    editor.putBoolean(key, (Boolean) parsed);
                } else if ("volumeBoost".equals(key) && parsed instanceof Number) {
                    editor.putFloat(key, ((Number) parsed).floatValue());
                } else if (parsed instanceof String) {
                    editor.putString(key, (String) parsed);
                } else if (parsed instanceof Boolean) {
                    editor.putBoolean(key, (Boolean) parsed);
                } else if (parsed instanceof Number && "volumeBoost".equals(key)) {
                    editor.putFloat(key, ((Number) parsed).floatValue());
                } else {
                    editor.putString(key, jsonValue);
                }
                editor.apply();
            } catch (Exception e) {
                editor.putString(key, jsonValue).apply();
                Log.e(TAG, "savePref failed for " + key, e);
            }
        }

        @JavascriptInterface
        public String popNextQueuedVideo() {
            if (remoteServerManager != null) {
                RemoteServerManager.QueueItem item = remoteServerManager.popNextQueuedVideo();
                if (item != null) {
                    return item.toJson().toString();
                }
            }
            return null;
        }

        @JavascriptInterface
        public String getQueueJson() {
            if (remoteServerManager != null) {
                return remoteServerManager.getQueueJson();
            }
            return "[]";
        }

        @JavascriptInterface
        public String getRemoteServerUrl() {
            if (remoteServerManager != null && remoteServerManager.isRunning()) {
                return remoteServerManager.getServerUrl();
            }
            return "";
        }

        @JavascriptInterface
        public void updateCurrentPlayback(String videoId, String title, boolean isPlaying, int volume) {
            if (remoteServerManager != null) {
                remoteServerManager.updatePlaybackState(videoId, title, isPlaying, volume);
            }
        }

        @JavascriptInterface
        public void clearQueue() {
            if (remoteServerManager != null) {
                remoteServerManager.clearQueue();
            }
        }

        @JavascriptInterface
        public void removeQueueItem(String id) {
            if (remoteServerManager != null) {
                remoteServerManager.removeQueueItem(id);
            }
        }
    }
}
