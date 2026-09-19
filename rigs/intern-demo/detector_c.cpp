// C ABI around TMnode's detector (src/tm_detector.cpp, compiled unchanged) so
// the rig's Python bridge runs the exact detector the nodes run.
#include <string.h>
#include "tm_detector.h"

static TmDetector g_det;

extern "C" {

void tmd_init(float min_contrast, float min_peak, float noise_k, int min_area, int max_area,
              int bg_tau, int bg_frames, float split_sep) {
    TmDetectorParams p;
    tm_detector_default_params(&p);
    p.min_contrast_c = min_contrast;
    p.min_peak_c = min_peak;
    p.noise_k = noise_k;
    p.min_area = (uint16_t) min_area;
    p.max_area = (uint16_t) max_area;
    p.bg_tau_frames = (uint16_t) bg_tau;
    p.bg_learn_frames = (uint16_t) bg_frames;
    p.split_sep_px = split_sep;
    tm_detector_init(&g_det, &p);
}

/** Returns the detection count; out gets 6 floats per detection: x y area contrast peak heat. flags: bit0 ready, bit1 shift, bit2 truncated. */
int tmd_step(const float* frame, float* out, int max_out, int* flags, float* bg_mean) {
    const int n = tm_detector_step(&g_det, frame);
    for (int i = 0; i < n && i < max_out; ++i) {
        const TmDetection* d = &g_det.detections[i];
        out[6 * i + 0] = d->x; out[6 * i + 1] = d->y; out[6 * i + 2] = d->area;
        out[6 * i + 3] = d->contrast; out[6 * i + 4] = d->peak; out[6 * i + 5] = d->heat;
    }
    *flags = (g_det.background_ready ? 1 : 0) | (g_det.global_shift ? 2 : 0) | (g_det.truncated ? 4 : 0);
    *bg_mean = g_det.background_ready ? tm_detector_background_mean(&g_det) : 0.0f;
    return n;
}

}
