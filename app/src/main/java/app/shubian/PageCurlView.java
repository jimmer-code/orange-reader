package app.shubian;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.PorterDuff;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Choreographer;
import android.view.MotionEvent;
import android.view.PixelCopy;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.VelocityTracker;
import android.view.View;
import android.view.Window;
import android.view.animation.PathInterpolator;
import android.webkit.WebView;

import java.util.ArrayDeque;

/**
 * 仿真翻页：WebView 上方一层 SurfaceView，按手指位置实时画卷页。
 *
 * 只在开始时把当前页截成位图 A（PixelCopy 截窗口，SurfaceView 不在窗口 Surface 里，所以截不到自己），
 * 随后让网页立即跳到目标页。卷页时：
 *   往后翻：A 的平铺部分和翻起部分用位图画，露出的下一页区域留透明，直接透出 WebView 里真实的下一页；
 *   往前翻：上一页从左边盖回来，上一页的部分留透明透出 WebView，被盖住的 A 用位图画。
 * 所以手指一动画面就跟着动，不用等第二张截图。目标页画好后再截一张（N），只用来画双页模式下纸背面的真实内容
 * 和单页模式下背面的淡色镜像。
 *
 * 画面完全由「页角位置」决定：手指停，纸就停；松手后用临界阻尼弹簧把页角送到翻完或退回的位置，中途可以再抓住。
 * 卷曲几何是常见的贝塞尔折页算法（折线为页角与触点的中垂线，两条二次贝塞尔模拟弯曲）。
 */
@android.annotation.SuppressLint("ViewConstructor")
public final class PageCurlView extends SurfaceView implements SurfaceHolder.Callback, Choreographer.FrameCallback {

    public interface Host {
        WebView web();
        Window window();
        void js(String code);
        void emit(String type, Object json);
    }

    private static final String TAG = "ShubianCurl";
    private static final int IDLE = 0, STARTING = 1, RUNNING = 2, ENDING = 3;
    private static final int AUTO_MS = 450, AUTO_FAST_MS = 280;

    private final Host host;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final float dp;
    private final int slop;
    private boolean surfaceReady;

    // ---- 网页通过 curlArm 推过来的状态 ----
    private boolean armed, canPrev, canNext, spread;
    private float readerX, readerY, readerW, readerH; // 阅读区在本 View 里的像素坐标

    // ---- 一次翻页 ----
    private int state = IDLE, token;
    private int dir;                       // +1 下一页，-1 上一页
    private Bitmap bmpA, bmpN;             // A=开始时的当前页；N=目标页（晚到，可以为空）
    private boolean nNeeded, nReady;
    private boolean navAsked, navDone, navOk, liveReady;
    private int paper = Color.WHITE;
    private final Paint bmpPaint = new Paint(Paint.FILTER_BITMAP_FLAG);
    private final Paint backPaint = new Paint(Paint.FILTER_BITMAP_FLAG);
    private final Paint fill = new Paint();

    // 页面几何（局部坐标：x 从卷页那一页的左边算起，单页=整屏，双页=右半页）
    private float ox, oy, pw, ph;
    private boolean cornerTop, middle;
    private float cornerX, cornerY;

    // 页角当前位置（未经算法修正的原始值）与动画
    private float tx, ty;
    private boolean dragging, animating, auto, toFlipped, ended;
    private float vx, vy;                   // 弹簧速度（局部像素/秒）
    private float relDx, relDy, overshoot;  // 松手时指向终点的单位向量；弹簧目标沿它多推一点，越过终点即结束
    private long lastFrameNanos;
    private long autoStart; private int autoMs; private boolean autoDirFwd;
    private final PathInterpolator autoEase = new PathInterpolator(0.42f, 0.05f, 0.2f, 1f);

    // 拖动映射：页角 = 手指 + 偏移，偏移随移动距离衰减到 0，起手不跳，拖一段后页角就在手指下
    private float downX, downY, startTx, startTy, decayDist;
    private VelocityTracker vt;
    private final float[] hist = new float[3 * 4]; private int histN; private long histBase;

    // ---- 手势（由 ReaderFrame 转发） ----
    private boolean tracking, intercepted, pastSlop;
    private float gx0, gy0, lastX, lastY; private int pointerId = -1;
    private boolean pendingDrag;            // 上一页还在收尾时开始的拖动：收尾后立即接手

    // ---- 自动翻页队列（点击、音量键、网页翻页队列） ----
    private static final class Job { final int id, dir; final boolean fast; Job(int id, int dir, boolean fast) { this.id = id; this.dir = dir; this.fast = fast; } }
    private final ArrayDeque<Job> jobs = new ArrayDeque<>();
    private Job current;

    // ---- 绘制用的临时对象 ----
    private final Path path0 = new Path(), path1 = new Path(), pathTmp = new Path();
    private final Matrix matrix = new Matrix();
    private final float[] m9 = {0, 0, 0, 0, 0, 0, 0, 0, 1f};
    private GradientDrawable backShadowLR, backShadowRL, folderShadowLR, folderShadowRL,
            frontShadowVLR, frontShadowVRL, frontShadowHTB, frontShadowHBT;
    private float mx, my, c1x, c1y, c2x, c2y, s1x, s1y, s2x, s2y, e1x, e1y, e2x, e2y, v1x, v1y, v2x, v2y, cx, cy, touchToCorner, maxLen;
    private final float[] xy = new float[2];

    public PageCurlView(Context ctx, Host host) {
        super(ctx);
        this.host = host;
        dp = ctx.getResources().getDisplayMetrics().density;
        slop = Math.round(8 * dp);
        setZOrderOnTop(true);
        getHolder().setFormat(PixelFormat.TRANSLUCENT);
        getHolder().addCallback(this);
        setFocusable(false);
        backPaint.setColorFilter(new ColorMatrixColorFilter(new ColorMatrix()));
        initShadows();
    }

    private void initShadows() {
        int[] back = {0x55111111, 0x00111111};
        backShadowLR = grad(GradientDrawable.Orientation.LEFT_RIGHT, back);
        backShadowRL = grad(GradientDrawable.Orientation.RIGHT_LEFT, back);
        int[] folder = {0x00333333, 0x66333333};
        folderShadowLR = grad(GradientDrawable.Orientation.LEFT_RIGHT, folder);
        folderShadowRL = grad(GradientDrawable.Orientation.RIGHT_LEFT, folder);
        int[] front = {0x48111111, 0x00111111};
        frontShadowVLR = grad(GradientDrawable.Orientation.LEFT_RIGHT, front);
        frontShadowVRL = grad(GradientDrawable.Orientation.RIGHT_LEFT, front);
        frontShadowHTB = grad(GradientDrawable.Orientation.TOP_BOTTOM, front);
        frontShadowHBT = grad(GradientDrawable.Orientation.BOTTOM_TOP, front);
    }

    private static GradientDrawable grad(GradientDrawable.Orientation o, int[] c) {
        GradientDrawable g = new GradientDrawable(o, c);
        g.setGradientType(GradientDrawable.LINEAR_GRADIENT);
        return g;
    }

    // ================= 网页桥接 =================

    /** 网页推送：能否接管拖动、能否前后翻、阅读区矩形（CSS 像素）和缩放。 */
    public void arm(boolean on, boolean prev, boolean next, boolean spread, float x, float y, float w, float h, float dpr) {
        armed = on; canPrev = prev; canNext = next;
        if (state == IDLE) {
            this.spread = spread;
            readerX = x * dpr; readerY = y * dpr; readerW = w * dpr; readerH = h * dpr;
        }
    }

    public void navDone(int tok, boolean ok) {
        if (tok != token || state == IDLE) return;
        navDone = true; navOk = ok;
        if (!ok) { // 到头或网页拒绝：直接退回
            liveReady = true;
            finishJob();
            if (state == RUNNING) { dragging = false; release(false, 0, 0); }
            else if (state == ENDING) maybeFinish();
            return;
        }
        WebView w = host.web();
        w.postVisualStateCallback(tok, new WebView.VisualStateCallback() {
            @Override public void onComplete(long id) {
                if (id != token || state == IDLE) return;
                // 回调表示下一次 onDraw 就是新内容；再等一帧，确保新页已经进了窗口 Surface
                Choreographer.getInstance().postFrameCallback(t -> {
                    if (id != token || state == IDLE) return;
                    liveReady = true; requestFrame();
                    if (nNeeded) Choreographer.getInstance().postFrameCallback(t2 -> captureN((int) id));
                    if (state == ENDING) maybeFinish();
                });
            }
        });
    }

    public void endDone(int tok) {
        if (tok != token || state != ENDING) return;
        host.web().postVisualStateCallback(tok, new WebView.VisualStateCallback() {
            @Override public void onComplete(long id) {
                Choreographer.getInstance().postFrameCallback(t -> {
                    Choreographer.getInstance().postFrameCallback(t2 -> { if (id == token && state == ENDING) toIdle(); });
                });
            }
        });
    }

    /** 点击、音量键翻页：排队执行，完成后发 curlDone(id)。 */
    public boolean auto(int id, int d, boolean fast) {
        if (!surfaceReady) return false;
        jobs.add(new Job(id, d, fast));
        if (state == IDLE) nextJob();
        return true;
    }

    /** 关书、换页面时：立即收尾。 */
    public void reset() {
        jobs.forEach(j -> host.emit("curlDone", String.valueOf(j.id)));
        jobs.clear();
        if (state != IDLE) {
            boolean committed = navOk;
            int tok = token;
            finishJob();
            host.js("window.curlEnd&&curlEnd(" + tok + "," + committed + ",true)");
            toIdle();
        }
        armed = false;
    }

    public boolean busy() { return state != IDLE; }

    private void nextJob() {
        if (state != IDLE || jobs.isEmpty()) return;
        Job j = jobs.poll();
        current = j;
        begin(j.dir, Float.NaN, Float.NaN, true);
    }

    private void finishJob() {
        if (current != null) { host.emit("curlDone", String.valueOf(current.id)); current = null; }
    }

    // ================= 手势 =================

    /** 返回 true 表示从这一刻起接管这次触摸。 */
    public boolean intercept(MotionEvent e) {
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                tracking = true; pastSlop = false; intercepted = false; pendingDrag = false;
                gx0 = lastX = e.getX(); gy0 = lastY = e.getY(); pointerId = e.getPointerId(0);
                if (state != IDLE) { intercepted = true; startVelocity(e); return true; }
                return false;
            case MotionEvent.ACTION_MOVE: {
                if (!tracking || state != IDLE || !armed || !surfaceReady) return false;
                int i = e.findPointerIndex(pointerId); if (i < 0) return false;
                float dx = e.getX(i) - gx0, dy = e.getY(i) - gy0;
                if (Math.abs(dx) < slop || Math.abs(dx) < Math.abs(dy) * 1.2f) {
                    if (Math.abs(dy) > slop * 2) tracking = false; // 竖向手势不接管
                    return false;
                }
                int d = dx < 0 ? 1 : -1;
                if (d > 0 ? !canNext : !canPrev) { tracking = false; return false; } // 让网页做到头回弹
                if (!inReader(gx0, gy0)) { tracking = false; return false; }
                intercepted = true; pastSlop = true;
                startVelocity(e);
                begin(d, gx0, gy0, false);
                onDragMove(e.getX(i), e.getY(i), e.getEventTime());
                return true;
            }
            case MotionEvent.ACTION_POINTER_DOWN:
                if (state == IDLE) tracking = false;
                return false;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                tracking = false;
                return false;
        }
        return false;
    }

    public boolean touch(MotionEvent e) {
        if (!intercepted) return false;
        int i = e.findPointerIndex(pointerId);
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_MOVE: {
                if (i < 0) return true;
                if (vt != null) vt.addMovement(e);
                float x = e.getX(i), y = e.getY(i);
                lastX = x; lastY = y;
                if (!pastSlop) {
                    if (Math.hypot(x - gx0, y - gy0) < slop) return true;
                    pastSlop = true;
                    // 动画进行中按住拖动：从当前页角位置接着拖；还在截图或收尾时先记下，就绪后接手
                    if (state == RUNNING && !dragging && (animating || auto)) grab(x, y);
                    else if (!dragging) pendingDrag = true;
                }
                if (dragging) onDragMove(x, y, e.getEventTime());
                return true;
            }
            case MotionEvent.ACTION_UP: {
                if (vt != null) vt.addMovement(e);
                float x = i >= 0 ? e.getX(i) : gx0;
                if (dragging) {
                    float fvx = 0;
                    if (vt != null) { vt.computeCurrentVelocity(1000); fvx = vt.getXVelocity(pointerId); }
                    dragging = false;
                    decideRelease(fvx);
                } else if (!pastSlop) {
                    tap(x);
                }
                pendingDrag = false;
                endTracking();
                return true;
            }
            case MotionEvent.ACTION_CANCEL:
                if (dragging) { dragging = false; decideRelease(0); }
                pendingDrag = false;
                endTracking();
                return true;
        }
        return true;
    }

    private void endTracking() {
        intercepted = false; tracking = false;
        if (vt != null) { vt.recycle(); vt = null; }
    }

    private void startVelocity(MotionEvent e) {
        if (vt != null) vt.recycle();
        vt = VelocityTracker.obtain();
        vt.addMovement(e);
    }

    private boolean inReader(float x, float y) {
        return readerW > 0 && x >= readerX && x <= readerX + readerW && y >= readerY && y <= readerY + readerH;
    }

    /** 翻页进行中点屏幕两侧：继续排队翻页（连续快速点击）。 */
    private void tap(float x) {
        float rx = x - readerX;
        int d = rx < readerW * 0.28f ? -1 : rx > readerW * 0.72f ? 1 : 0;
        if (d == 0) return;
        jobs.add(new Job(-1, d, true));
    }

    // ================= 一次翻页的生命周期 =================

    private void begin(int d, float fx, float fy, boolean isAuto) {
        state = STARTING; token++;
        dir = d;
        navAsked = navDone = navOk = liveReady = nReady = false; ended = false;
        dragging = !isAuto; auto = false; animating = false;
        bmpN = recycleIfWrongSize(bmpN);
        final int tok = token;
        geometry();
        Rect src = webRectInWindow();
        bmpA = ensure(bmpA, src.width(), src.height());
        if (!isAuto) { downX = fx; downY = fy; chooseCorner(fy - oy); }
        else { cornerTop = false; middle = false; cornerX = pw; cornerY = ph; }
        // 开始状态：往后翻=平铺；往前翻=已翻过去（上一页在左边外面）
        float[] s = dir > 0 ? flatPoint() : flippedPoint();
        tx = s[0]; ty = s[1]; vx = vy = 0;
        startTx = tx; startTy = ty;
        if (!isAuto) decayDist = dir > 0 ? Math.max(pw * 0.3f, 1) : Math.max(pw * 0.3f, Math.abs(tx - (fx - ox)) * 0.55f);
        histN = 0; histBase = android.os.SystemClock.uptimeMillis();
        try {
            PixelCopy.request(host.window(), src, bmpA, r -> {
                if (tok != token || state != STARTING) return;
                if (r != PixelCopy.SUCCESS) { Log.w(TAG, "PixelCopy A failed " + r); abort(); return; }
                paper = samplePaper(bmpA);
                nNeeded = spread ? dir > 0 : dir < 0; // 背面需要目标页的真实内容
                state = RUNNING;
                if (isAuto) startAuto();
                if (pendingDrag && intercepted && isAuto) { pendingDrag = false; grab(lastX, lastY); }
                drawNow();
                // 覆盖层的第一帧先上屏，再让网页换页，换页那一帧永远被盖住
                Choreographer.getInstance().postFrameCallback(t -> Choreographer.getInstance().postFrameCallback(t2 -> askNav(tok)));
                requestFrame();
            }, main);
        } catch (Exception ex) {
            Log.w(TAG, "PixelCopy A threw", ex); abort();
        }
    }

    private void askNav(int tok) {
        if (tok != token || state == IDLE || navAsked) return;
        navAsked = true;
        host.js("window.curlNav&&curlNav(" + tok + "," + dir + ")");
    }

    private void abort() {
        int tok = token;
        state = IDLE; dragging = animating = auto = false;
        clearSurface();
        if (navAsked) host.js("window.curlEnd&&curlEnd(" + tok + ",false,true)");
        finishJob();
        main.post(this::nextJob);
    }

    private void captureN(int tok) {
        if (tok != token || state == IDLE || !nNeeded) return;
        Rect src = webRectInWindow();
        bmpN = ensure(bmpN, src.width(), src.height());
        try {
            PixelCopy.request(host.window(), src, bmpN, r -> {
                if (tok != token) return;
                if (r == PixelCopy.SUCCESS) { nNeeded = false; nReady = true; requestFrame(); }
            }, main);
        } catch (Exception ignored) { }
    }

    private void grab(float x, float y) {
        animating = false; auto = false; dragging = true;
        downX = x; downY = y; startTx = tx; startTy = ty; decayDist = Math.max(pw * 0.3f, 1);
        histN = 0; histBase = android.os.SystemClock.uptimeMillis();
        // 用户接手：后面排队的自动翻页作废
        jobs.forEach(j -> host.emit("curlDone", String.valueOf(j.id))); jobs.clear();
        finishJob();
    }

    private void onDragMove(float x, float y, long t) {
        float fx = x - ox, fy = y - oy;
        float dX = x - downX, dY = y - downY;
        float k = Math.max(0f, 1f - Math.abs(dX) / decayDist);
        float offX = (startTx - (downX - ox)) * k, offY = (startTy - (downY - oy)) * k;
        float nx = fx + offX, ny = fy + offY;
        if (middle) ny = ph - 1f;
        // 方向锁：往后翻时手指回到起点右边 = 平铺，往前翻同理
        setTouch(nx, ny);
        pushHist(t);
        requestFrame();
    }

    private void pushHist(long t) {
        System.arraycopy(hist, 0, hist, 3, hist.length - 3);
        hist[0] = tx; hist[1] = ty; hist[2] = t - histBase;
        histN = Math.min(4, histN + 1);
    }

    private void setTouch(float x, float y) {
        x = Math.max(-pw * 1.02f, Math.min(pw, x));
        if (!middle) {
            float lo = cornerTop ? 0.5f : -ph * 0.2f, hi = cornerTop ? ph * 1.2f : ph - 0.5f;
            y = Math.max(lo, Math.min(hi, y));
        }
        tx = x; ty = y;
    }

    private void decideRelease(float fingerVx) {
        float th = 380 * dp;
        float p = progress();
        boolean flip;
        if (fingerVx < -th) flip = true;
        else if (fingerVx > th) flip = false;
        else flip = dir > 0 ? p > 0.2f : p > 0.8f;
        // 速度：用最近几次页角位置估计，弹簧从这个速度接着走
        vx = vy = 0;
        if (histN >= 2) {
            int last = Math.min(histN, 4) - 1;
            float dt = (hist[2] - hist[last * 3 + 2]) / 1000f;
            if (dt > 0.004f) { vx = (hist[0] - hist[last * 3]) / dt; vy = (hist[1] - hist[last * 3 + 1]) / dt; }
        }
        release(flip, vx, vy);
    }

    private void release(boolean flip, float v0x, float v0y) {
        toFlipped = flip; animating = true; auto = false;
        vx = v0x; vy = v0y;
        float[] t = flip ? flippedPoint() : flatPoint();
        relDx = t[0] - tx; relDy = t[1] - ty;
        float len = (float) Math.hypot(relDx, relDy);
        if (len < 1) { relDx = flip ? -1 : 1; relDy = 0; len = 1; }
        relDx /= len; relDy /= len;
        overshoot = Math.max(pw * 0.05f, 12 * dp);
        lastFrameNanos = 0;
        requestFrame();
    }

    private void startAuto() {
        auto = true; animating = false;
        autoDirFwd = dir > 0;
        autoMs = (current != null && current.fast) || !jobs.isEmpty() ? AUTO_FAST_MS : AUTO_MS;
        autoStart = 0;
    }

    /** 动画到达终点。 */
    private void arrive() {
        animating = auto = false; ended = true;
        float[] p = toFlipped ? flippedPoint() : flatPoint();
        tx = p[0]; ty = p[1];
        drawNow();
        state = ENDING;
        maybeFinish();
    }

    private boolean committed() { return dir > 0 ? toFlipped : !toFlipped; }

    private void maybeFinish() {
        if (state != ENDING || !ended) return;
        if (navAsked && !navDone) return;            // 换章还在加载
        if (!navAsked) {                              // 太快：网页还没换页就结束了
            if (committed()) { askNav(token); return; }
            int tok = token; host.js("window.curlEnd&&curlEnd(" + tok + ",false,false)"); finishJob(); toIdle(); return;
        }
        if (navOk && committed() && !liveReady) return;
        int tok = token;
        boolean c = committed() && navOk;
        host.js("window.curlEnd&&curlEnd(" + tok + "," + c + ",false)");
        finishJob();
        if (c) toIdle();               // 已经全是真实的新页，覆盖层直接清掉
        // 退回：网页先回到原页，endDone 后再清覆盖层（此时覆盖层整屏是 A）
        else if (!navOk) toIdle();
    }

    private void toIdle() {
        state = IDLE; dragging = animating = auto = false;
        clearSurface();
        if (pendingDrag && intercepted && surfaceReady) {
            // 上一页刚收尾，手指还按着：直接开始新的一次拖动，排队的点击作废
            pendingDrag = false;
            jobs.forEach(j -> host.emit("curlDone", String.valueOf(j.id))); jobs.clear();
            float dx = lastX - gx0;
            if (Math.abs(dx) >= slop) {
                // 从手指当前位置起算，页面从平铺开始跟，不会一下跳到手指处
                begin(dx < 0 ? 1 : -1, lastX, lastY, false);
                gx0 = lastX; gy0 = lastY;
                return;
            }
        }
        main.post(this::nextJob);
    }

    // ================= 动画 =================

    private void requestFrame() {
        Choreographer.getInstance().removeFrameCallback(this);
        Choreographer.getInstance().postFrameCallback(this);
    }

    @Override public void doFrame(long now) {
        if (state != RUNNING) return;
        boolean more = false;
        if (auto) {
            if (autoStart == 0) autoStart = now;
            float t = Math.min(1f, (now - autoStart) / 1e6f / autoMs);
            float e = autoEase.getInterpolation(t);
            float f = autoDirFwd ? e : 1f - e;               // f：0=平铺，1=翻过去
            tx = pw - (2f * pw * 1.02f) * f;
            ty = ph - ph * 0.12f * (float) Math.sin(Math.PI * f);
            toFlipped = autoDirFwd;
            if (t >= 1f) { arrive(); return; }
            more = true;
        } else if (animating) {
            float dt = lastFrameNanos == 0 ? 1 / 60f : Math.min(0.05f, (now - lastFrameNanos) / 1e9f);
            lastFrameNanos = now;
            float[] target = toFlipped ? flippedPoint() : flatPoint();
            // 目标沿松手方向再往前推一点，越过真正终点即结束，避免弹簧尾巴拖得太长
            float gxT = target[0] + relDx * overshoot, gyT = target[1] + relDy * overshoot;
            float w = 17f; // 临界阻尼弹簧，约 0.35s
            float ax = -w * w * (tx - gxT) - 2 * w * vx, ay = -w * w * (ty - gyT) - 2 * w * vy;
            vx += ax * dt; vy += ay * dt;
            tx += vx * dt; ty += vy * dt;
            boolean done = (tx - target[0]) * relDx + (ty - target[1]) * relDy >= -0.5f;
            if (done) { arrive(); return; }
            more = true;
        }
        drawNow();
        if (more) Choreographer.getInstance().postFrameCallback(this);
    }

    private float progress() { return Math.max(0f, Math.min(1f, (pw - tx) / (2f * pw))); }
    private float[] flatPoint() { return new float[]{pw, cornerY == 0 ? 0.5f : ph - 0.5f}; }
    private float[] flippedPoint() { return new float[]{-pw * 1.02f, cornerY == 0 ? 0.5f : ph - 0.5f}; }

    // ================= 几何 =================

    private void geometry() {
        if (readerW <= 0) { readerX = 0; readerY = 0; readerW = getWidth(); readerH = getHeight(); }
        pw = spread ? readerW / 2f : readerW;
        ph = readerH;
        ox = readerX + (spread ? readerW / 2f : 0);
        oy = readerY;
        maxLen = (float) Math.hypot(readerW, readerH);
    }

    private void chooseCorner(float ly) {
        middle = ly > ph / 3f && ly < ph * 2f / 3f;
        cornerTop = !middle && ly <= ph / 3f;
        cornerX = pw; cornerY = cornerTop ? 0 : ph;
    }

    private void calcPoints() {
        cx = tx; cy = ty;
        if (middle) cy = ph - 1f;
        if (cx > pw - 0.01f) cx = pw - 0.01f;
        control(cx, cy);
        if (cx > 0 && cx < pw && (s1x < 0 || s1x > pw)) {
            if (s1x < 0) s1x = pw - s1x;
            float f1 = Math.abs(cornerX - cx);
            float f2 = pw * f1 / s1x;
            cx = Math.abs(cornerX - f2);
            float f3 = Math.abs(cornerX - cx) * Math.abs(cornerY - cy) / f1;
            cy = Math.abs(cornerY - f3);
            control(cx, cy);
        }
        s2x = cornerX; s2y = c2y - (cornerY - c2y) / 2f;
        touchToCorner = (float) Math.hypot(cx - cornerX, cy - cornerY);
        cross(cx, cy, c1x, c1y, s1x, s1y, s2x, s2y); e1x = xy[0]; e1y = xy[1];
        cross(cx, cy, c2x, c2y, s1x, s1y, s2x, s2y); e2x = xy[0]; e2y = xy[1];
        v1x = (s1x + 2 * c1x + e1x) / 4f; v1y = (2 * c1y + e1y + s1y) / 4f;
        v2x = (s2x + 2 * c2x + e2x) / 4f; v2y = (2 * c2y + e2y + s2y) / 4f;
    }

    private void control(float x, float y) {
        mx = (x + cornerX) / 2f; my = (y + cornerY) / 2f;
        float dx = cornerX - mx; if (dx < 0.01f) dx = 0.01f;
        float dy = cornerY - my; if (Math.abs(dy) < 0.01f) dy = cornerY == 0 ? -0.01f : 0.01f;
        c1x = mx - (cornerY - my) * (cornerY - my) / dx; c1y = cornerY;
        c2x = cornerX; c2y = my - dx * dx / dy;
        s1x = c1x - (cornerX - c1x) / 2f; s1y = cornerY;
    }

    private void cross(float x1, float y1, float x2, float y2, float x3, float y3, float x4, float y4) {
        float d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
        if (Math.abs(d) < 1e-6f) { xy[0] = x2; xy[1] = y2; return; }
        float a = x1 * y2 - y1 * x2, b = x3 * y4 - y3 * x4;
        xy[0] = (a * (x3 - x4) - (x1 - x2) * b) / d;
        xy[1] = (a * (y3 - y4) - (y1 - y2) * b) / d;
    }

    // ================= 绘制 =================

    private void drawNow() {
        if (!surfaceReady) return;
        Canvas c;
        try { c = getHolder().getSurface().lockHardwareCanvas(); } catch (Exception e) { return; }
        try {
            c.drawColor(0, PorterDuff.Mode.CLEAR);
            render(c);
        } finally {
            getHolder().getSurface().unlockCanvasAndPost(c);
        }
    }

    private void clearSurface() {
        if (!surfaceReady) return;
        try {
            Canvas c = getHolder().getSurface().lockHardwareCanvas();
            c.drawColor(0, PorterDuff.Mode.CLEAR);
            getHolder().getSurface().unlockCanvasAndPost(c);
        } catch (Exception ignored) { }
    }

    /**
     * X = 正在卷的那张纸的正面（往后翻=A，往前翻=上一页，后者是 WebView 实时内容）
     * Y = 卷起后露出的那一页（往后翻=下一页，实时；往前翻=A）
     */
    private void render(Canvas c) {
        if (bmpA == null) return;
        c.save();
        c.translate(ox, oy);
        boolean flat = tx >= pw - 0.5f, flipped = tx <= -pw * 1.0f;
        if (flat) { drawX(c); c.restore(); return; }
        if (flipped) { drawY(c); c.restore(); return; }
        calcPoints();
        float degrees = (float) Math.toDegrees(Math.atan2(c1x - cornerX, c2y - cornerY));
        boolean rtlb = cornerTop; // 右上角 / 左下角

        path0.reset();
        path0.moveTo(s1x, s1y);
        path0.quadTo(c1x, c1y, e1x, e1y);
        path0.lineTo(cx, cy);
        path0.lineTo(e2x, e2y);
        path0.quadTo(c2x, c2y, s2x, s2y);
        path0.lineTo(cornerX, cornerY);
        path0.close();

        // 1. 当前纸张平铺的部分
        c.save(); c.clipOutPath(path0); drawX(c); c.restore();

        // 2. 露出的下一页 + 折痕投在下一页上的阴影
        path1.reset();
        path1.moveTo(s1x, s1y); path1.lineTo(v1x, v1y); path1.lineTo(v2x, v2y);
        path1.lineTo(s2x, s2y); path1.lineTo(cornerX, cornerY); path1.close();
        c.save();
        c.clipPath(path0); c.clipPath(path1);
        drawY(c);
        c.rotate(degrees, s1x, s1y);
        int l, r; GradientDrawable g;
        if (rtlb) { l = (int) s1x; r = (int) (s1x + touchToCorner / 4); g = backShadowLR; }
        else { l = (int) (s1x - touchToCorner / 4); r = (int) s1x; g = backShadowRL; }
        g.setBounds(l, (int) s1y - (rtlb ? 0 : (int) maxLen), r, (int) (maxLen + s1y));
        g.draw(c);
        c.restore();

        // 3. 翻起部分投在当前页上的阴影
        drawFrontShadow(c, rtlb);

        // 4. 翻起部分的背面
        drawBack(c, rtlb, degrees);
        c.restore();
    }

    private void drawFrontShadow(Canvas c, boolean rtlb) {
        float w = 16 * dp;
        double degree = rtlb ? Math.PI / 4 - Math.atan2(c1y - cy, cx - c1x) : Math.PI / 4 - Math.atan2(cy - c1y, cx - c1x);
        float d1 = (float) (w * 1.414 * Math.cos(degree)), d2 = (float) (w * 1.414 * Math.sin(degree));
        float x = cx + d1, y = rtlb ? cy + d2 : cy - d2;

        pathTmp.reset();
        pathTmp.moveTo(x, y); pathTmp.lineTo(cx, cy); pathTmp.lineTo(c1x, c1y); pathTmp.lineTo(s1x, s1y); pathTmp.close();
        c.save();
        c.clipOutPath(path0); c.clipPath(pathTmp);
        GradientDrawable g; int l, r;
        if (rtlb) { l = (int) c1x; r = (int) (c1x + w); g = frontShadowVLR; }
        else { l = (int) (c1x - w); r = (int) c1x + 1; g = frontShadowVRL; }
        c.rotate((float) Math.toDegrees(Math.atan2(cx - c1x, c1y - cy)), c1x, c1y);
        g.setBounds(l, (int) (c1y - maxLen), r, (int) c1y);
        g.draw(c);
        c.restore();

        pathTmp.reset();
        pathTmp.moveTo(x, y); pathTmp.lineTo(cx, cy); pathTmp.lineTo(c2x, c2y); pathTmp.lineTo(s2x, s2y); pathTmp.close();
        c.save();
        c.clipOutPath(path0); c.clipPath(pathTmp);
        if (rtlb) { l = (int) c2y; r = (int) (c2y + w); g = frontShadowHTB; }
        else { l = (int) (c2y - w); r = (int) (c2y + 1); g = frontShadowHBT; }
        c.rotate((float) Math.toDegrees(Math.atan2(c2y - cy, c2x - cx)), c2x, c2y);
        float temp = c2y < 0 ? c2y - ph : c2y;
        int hmg = (int) Math.hypot(c2x, temp);
        if (hmg > maxLen) g.setBounds((int) (c2x - w) - hmg, l, (int) (c2x + maxLen) - hmg, r);
        else g.setBounds((int) (c2x - maxLen), l, (int) c2x, r);
        g.draw(c);
        c.restore();
    }

    private void drawBack(Canvas c, boolean rtlb, float degrees) {
        float i = (s1x + c1x) / 2f, f1 = Math.abs(i - c1x);
        float i1 = (s2y + c2y) / 2f, f2 = Math.abs(i1 - c2y);
        float f3 = Math.min(f1, f2);
        pathTmp.reset();
        pathTmp.moveTo(v2x, v2y); pathTmp.lineTo(v1x, v1y); pathTmp.lineTo(e1x, e1y);
        pathTmp.lineTo(cx, cy); pathTmp.lineTo(e2x, e2y); pathTmp.close();
        c.save();
        c.clipPath(path0); c.clipPath(pathTmp);
        c.drawColor(paper);

        // 沿折线的镜像矩阵
        float dis = (float) Math.hypot(cornerX - c1x, c2y - cornerY);
        float f8 = (cornerX - c1x) / dis, f9 = (c2y - cornerY) / dis;
        m9[0] = 1 - 2 * f9 * f9; m9[1] = 2 * f8 * f9; m9[3] = m9[1]; m9[4] = 1 - 2 * f8 * f8;
        matrix.reset(); matrix.setValues(m9);
        matrix.preTranslate(-c1x, -c1y); matrix.postTranslate(c1x, c1y);
        if (spread) {
            // 双页：纸背面是目标页的左页，先以书脊为轴翻到右边，再沿折线镜像，文字是正的
            Bitmap back = dir > 0 ? (nReady ? bmpN : null) : bmpA;
            if (back != null) {
                matrix.preScale(-1, 1);              // 局部坐标 x → -x（书脊在 x=0）
                matrix.preTranslate(-ox, -oy);       // 位图是整屏坐标
                c.drawBitmap(back, matrix, bmpPaint);
            }
        } else {
            // 单页：背面透出正面的淡色镜像
            Bitmap front = dir > 0 ? bmpA : (nReady ? bmpN : null);
            if (front != null) {
                matrix.preTranslate(-ox, -oy);
                backPaint.setAlpha(46);
                c.drawBitmap(front, matrix, backPaint);
            }
        }
        // 背面整体略暗一点，越靠近折线越暗
        c.rotate(degrees, s1x, s1y);
        GradientDrawable g; int l, r;
        if (rtlb) { l = (int) (s1x - 1); r = (int) (s1x + f3 + 1); g = folderShadowLR; }
        else { l = (int) (s1x - f3 - 1); r = (int) (s1x + 1); g = folderShadowRL; }
        g.setBounds(l, (int) s1y - (rtlb ? 0 : (int) maxLen), r, (int) (s1y + maxLen));
        g.draw(c);
        c.restore();
    }

    /** 正在卷的纸的正面。 */
    private void drawX(Canvas c) {
        if (dir > 0) c.drawBitmap(bmpA, -ox, -oy, bmpPaint);
        else if (!liveReady) { fill.setColor(paper); c.drawRect(-ox, -oy, getWidth() - ox, getHeight() - oy, fill); }
        // 往前翻且网页已经换好：留透明，透出实时的上一页
    }

    /** 卷起后露出的那一页。 */
    private void drawY(Canvas c) {
        if (dir < 0) c.drawBitmap(bmpA, -ox, -oy, bmpPaint);
        else if (!liveReady) { fill.setColor(paper); c.drawRect(-ox, -oy, getWidth() - ox, getHeight() - oy, fill); }
    }

    // ================= 工具 =================

    private Rect webRectInWindow() {
        int[] loc = new int[2];
        host.web().getLocationInWindow(loc);
        return new Rect(loc[0], loc[1], loc[0] + host.web().getWidth(), loc[1] + host.web().getHeight());
    }

    private static Bitmap ensure(Bitmap b, int w, int h) {
        if (b != null && !b.isRecycled() && b.getWidth() == w && b.getHeight() == h) return b;
        if (b != null) b.recycle();
        return Bitmap.createBitmap(Math.max(1, w), Math.max(1, h), Bitmap.Config.ARGB_8888);
    }

    private Bitmap recycleIfWrongSize(Bitmap b) {
        if (b == null) return null;
        int w = host.web().getWidth(), h = host.web().getHeight();
        if (b.getWidth() == w && b.getHeight() == h) return b;
        b.recycle(); return null;
    }

    /** 纸色：取阅读区左右边距里的像素。 */
    private int samplePaper(Bitmap b) {
        int x = (int) Math.max(1, Math.min(b.getWidth() - 2, readerX + 3 * dp));
        int y = (int) Math.max(1, Math.min(b.getHeight() - 2, readerY + readerH / 2));
        return b.getPixel(x, y) | 0xff000000;
    }

    public void releaseBitmaps() {
        if (state != IDLE) return;
        if (bmpA != null) { bmpA.recycle(); bmpA = null; }
        if (bmpN != null) { bmpN.recycle(); bmpN = null; }
    }

    @Override public void surfaceCreated(SurfaceHolder h) { surfaceReady = true; clearSurface(); }
    @Override public void surfaceChanged(SurfaceHolder h, int f, int w, int hh) { if (state == IDLE) clearSurface(); else drawNow(); }
    @Override public void surfaceDestroyed(SurfaceHolder h) {
        surfaceReady = false;
        if (state != IDLE) reset();
    }

    @Override protected void onSizeChanged(int w, int h, int ow, int oh) {
        super.onSizeChanged(w, h, ow, oh);
        if (state != IDLE && (ow != 0 || oh != 0)) reset();
    }

    /** 根布局：在 WebView 收到触摸之前判断要不要接管水平拖动。 */
    public static final class ReaderFrame extends android.widget.FrameLayout {
        PageCurlView curl;
        public ReaderFrame(Context c) { super(c); }
        @Override public boolean onInterceptTouchEvent(MotionEvent e) {
            return curl != null && curl.getVisibility() == View.VISIBLE && curl.intercept(e);
        }
        @android.annotation.SuppressLint("ClickableViewAccessibility")
        @Override public boolean onTouchEvent(MotionEvent e) {
            return curl != null && curl.touch(e);
        }
    }
}
