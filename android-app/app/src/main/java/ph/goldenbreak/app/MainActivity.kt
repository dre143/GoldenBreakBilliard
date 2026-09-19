package ph.goldenbreak.app

import android.Manifest
import android.annotation.SuppressLint
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.ServiceWorkerClientCompat
import androidx.webkit.ServiceWorkerControllerCompat
import androidx.webkit.WebViewFeature

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private val printerBridge = PrinterBridge()
    private val retryHandler = Handler(Looper.getMainLooper())
    private var retryScheduled = false

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { loadApp() }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
        webView = WebView(this)
        setContentView(webView)
        // Counter tablet: keep the screen on while the app is open, and run full screen.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        enterFullScreen()

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.javaScriptCanOpenWindowsAutomatically = true
        // Forcing LAYER_TYPE_HARDWARE here used to sit on top of the window's
        // own hardwareAccelerated="true" (manifest) — a second, redundant
        // GPU-backed layer that has to be fully reallocated at the new
        // dimensions on every rotation. On the low-RAM tablets this app
        // actually runs on, that reallocation was the multi-second freeze
        // reported on every orientation flip. The window-level flag alone is
        // enough; WebView's own default layer type is lighter.

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        // Lets the web app's own service worker (public/sw.js) reliably
        // intercept and cache fetches — WebView has historically been
        // inconsistent about handing service-worker-driven requests through
        // its normal request-handling path without this explicit wiring.
        // Feature-checked since older WebView builds on some tablets may not
        // support it; degrades to plain WebView behavior, not a crash.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) {
            ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(
                object : ServiceWorkerClientCompat() {
                    override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? {
                        // Returning null lets the service worker's own fetch
                        // handling proceed normally — nothing to override here,
                        // just making sure this path is actually wired up.
                        return null
                    }
                }
            )
        }

        webView.webViewClient = object : WebViewClient() {
            // Without this override, Android's default behavior when the
            // WebView's renderer process is killed (low-memory tablets doing
            // this under any GPU/memory pressure, e.g. right after the
            // layer-type fix above but not eliminated by it) is to crash the
            // whole app outright, forcing the cashier to manually reopen it.
            // Recreating the activity instead gets them back to a working
            // screen on its own.
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                recreate()
                return true
            }

            // A render-process recreate (above) — or any other reload —
            // calls loadApp() again, which is a fresh top-level navigation.
            // If that lands with no internet, WebView's own offline
            // interstitial ("Web page unavailable") would otherwise replace
            // the screen and just sit there until someone manually reopens
            // the app. Retrying instead means it recovers on its own the
            // moment either the service worker manages to serve a cached
            // copy or real connectivity actually returns — no cashier
            // intervention needed. Only main-frame failures matter here;
            // a failed subresource (an image, a font) is normal and
            // shouldn't trigger a full page reload.
            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                if (request.isForMainFrame) scheduleRetry()
            }

            override fun onReceivedHttpError(
                view: WebView,
                request: WebResourceRequest,
                errorResponse: WebResourceResponse
            ) {
                if (request.isForMainFrame) scheduleRetry()
            }
        }
        webView.webChromeClient = WebChromeClient()
        webView.addJavascriptInterface(printerBridge, "GoldenBreakNativePrinter")

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            permissionLauncher.launch(
                arrayOf(
                    Manifest.permission.BLUETOOTH_CONNECT,
                    Manifest.permission.BLUETOOTH_SCAN,
                )
            )
        } else {
            loadApp()
        }
    }

    /**
     * Hide the status and navigation bars (immersive mode). A swipe from the screen edge shows them
     * for a moment, then they hide again, so staff can still reach Android when they need to.
     */
    private fun enterFullScreen() {
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    // Dialogs, the keyboard, or returning from Android settings can bring the bars back.
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterFullScreen()
    }

    private fun scheduleRetry() {
        if (retryScheduled) return
        retryScheduled = true
        retryHandler.postDelayed({
            retryScheduled = false
            loadApp()
        }, 2000)
    }

    private fun loadApp() {
        webView.loadUrl("${getString(R.string.app_url)}?v=${BuildConfig.VERSION_NAME}")
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (this::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    override fun onDestroy() {
        retryHandler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
}
