// Blackmagic RAW helper for SharedCut: reads a .braw clip through Blackmagic's own RAW SDK (the decoder DaVinci Resolve
// uses), so every Camera Raw setting means exactly what it means there. Built per host by scripts/setup-braw.mjs against
// the SDK installed on that machine (macOS, Linux, Windows); the server runs it as FRAME_LINE_BRAW.
//
//   braw info   <clip> --lib <dir>                      JSON: size, rate, camera, as-shot settings, choices and ranges
//   braw decode <clip> --lib <dir> [--scale full|half|quarter|eighth] [--start N] [--count N] [--threads N]
//               [--set key=value ...]                   16-bit RGB frames (FFmpeg rgb48le), in order, on stdout
//
// Keys are the SDK's .sidecar names: iso, white_balance_kelvin, white_balance_tint, exposure, viewing_bmdgen,
// viewing_gamut, viewing_gamma, tone_curve_*, highlight_recovery, gamut_compression_enable, post_3dlut_mode.
// A key left out keeps the camera's value for each frame, as Resolve's "Decode using: Camera metadata" does.
#include "BlackmagicRawAPI.h"
#include "PlatformHelpers.h"

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#else
#include <csignal>
#endif

static void fail(const std::string& message, int code = 1) { std::fprintf(stderr, "braw: %s\n", message.c_str()); std::exit(code); }
static void check(HRESULT result, const char* what) { if (FAILED(result)) fail(std::string(what) + " failed"); }

// --- attributes -----------------------------------------------------------------------------------------------------

enum class Kind { U16, S16, U32, Float, String };
struct Attribute { const char* key; bool clip; uint32_t id; Kind kind; };
// Order matters when setting: science, gamut and gamma first, because choosing a gamma resets its tone curve.
static const Attribute ATTRIBUTES[] = {
	{ "viewing_bmdgen", true, blackmagicRawClipProcessingAttributeColorScienceGen, Kind::U16 },
	{ "viewing_gamut", true, blackmagicRawClipProcessingAttributeGamut, Kind::String },
	{ "viewing_gamma", true, blackmagicRawClipProcessingAttributeGamma, Kind::String },
	{ "tone_curve_contrast", true, blackmagicRawClipProcessingAttributeToneCurveContrast, Kind::Float },
	{ "tone_curve_saturation", true, blackmagicRawClipProcessingAttributeToneCurveSaturation, Kind::Float },
	{ "tone_curve_midpoint", true, blackmagicRawClipProcessingAttributeToneCurveMidpoint, Kind::Float },
	{ "tone_curve_highlights", true, blackmagicRawClipProcessingAttributeToneCurveHighlights, Kind::Float },
	{ "tone_curve_shadows", true, blackmagicRawClipProcessingAttributeToneCurveShadows, Kind::Float },
	{ "tone_curve_black_level", true, blackmagicRawClipProcessingAttributeToneCurveBlackLevel, Kind::Float },
	{ "tone_curve_white_level", true, blackmagicRawClipProcessingAttributeToneCurveWhiteLevel, Kind::Float },
	{ "tone_curve_video_black_level", true, blackmagicRawClipProcessingAttributeToneCurveVideoBlackLevel, Kind::U16 },
	{ "highlight_recovery", true, blackmagicRawClipProcessingAttributeHighlightRecovery, Kind::U16 },
	{ "gamut_compression_enable", true, blackmagicRawClipProcessingAttributeGamutCompressionEnable, Kind::U16 },
	{ "post_3dlut_mode", true, blackmagicRawClipProcessingAttributePost3DLUTMode, Kind::String },
	{ "lens_shading_enable", true, blackmagicRawClipProcessingAttributeLensShadingEnable, Kind::U16 },
	{ "lens_distortion_correction_enable", true, blackmagicRawClipProcessingAttributeLensDistortionCorrectionEnable, Kind::U16 },
	{ "lens_chromatic_aberration_correction_enable", true, blackmagicRawClipProcessingAttributeLensChromaticAberrationCorrectionEnable, Kind::U16 },
	{ "iso", false, blackmagicRawFrameProcessingAttributeISO, Kind::U32 },
	{ "white_balance_kelvin", false, blackmagicRawFrameProcessingAttributeWhiteBalanceKelvin, Kind::U32 },
	{ "white_balance_tint", false, blackmagicRawFrameProcessingAttributeWhiteBalanceTint, Kind::S16 },
	{ "exposure", false, blackmagicRawFrameProcessingAttributeExposure, Kind::Float },
};

static const Attribute* attribute(const std::string& key) {
	for (const Attribute& a : ATTRIBUTES) if (key == a.key) return &a;
	return nullptr;
}

/** One setting, held as the variant the SDK takes. The string stays owned here, so the variant is never cleared. */
struct Setting {
	const Attribute* attribute;
	std::string text;
	std::shared_ptr<COM::String> string;
	COM::Variant value;
	Setting(const Attribute* a, const std::string& raw) : attribute(a), text(raw) {
		std::memset(&value, 0, sizeof value);
		char* end = nullptr;
		const double number = std::strtod(raw.c_str(), &end);
		const bool numeric = !raw.empty() && end && *end == '\0';
		if (a->kind != Kind::String && !numeric) fail(std::string(a->key) + " needs a number");
		switch (a->kind) {
			case Kind::U16: value.vt = blackmagicRawVariantTypeU16; value.uiVal = (uint16_t)number; break;
			case Kind::S16: value.vt = blackmagicRawVariantTypeS16; value.iVal = (int16_t)number; break;
			case Kind::U32: value.vt = blackmagicRawVariantTypeU32; value.uintVal = (uint32_t)number; break;
			case Kind::Float: value.vt = blackmagicRawVariantTypeFloat32; value.fltVal = (float)number; break;
			case Kind::String: string = std::make_shared<COM::String>(raw.c_str()); value.vt = blackmagicRawVariantTypeString; value.bstrVal = *string; break;
		}
	}
};

// --- JSON -----------------------------------------------------------------------------------------------------------

static std::string quote(const std::string& text) {
	std::string out = "\"";
	for (unsigned char c : text) {
		if (c == '"' || c == '\\') { out += '\\'; out += (char)c; }
		else if (c < 0x20) { char buffer[8]; std::snprintf(buffer, sizeof buffer, "\\u%04x", c); out += buffer; }
		else out += (char)c;
	}
	return out + "\"";
}
/** PlatformHelpers' macOS conversion pads with NULs to the buffer size; the text ends at the first one. */
static std::string text(COM::NativeString native) { const std::string padded = COM::String(native).str(); return padded.substr(0, std::strlen(padded.c_str())); }
static std::string number(double value) {
	if (value != value || value > 1e300 || value < -1e300) return "null";
	char buffer[32]; std::snprintf(buffer, sizeof buffer, "%.9g", value); return buffer;
}

/** A variant as JSON. Arrays over 64 items (embedded LUT data, motion blocks) are left out as null. */
static std::string json(COM::Variant& v) {
	switch (v.vt) {
		case blackmagicRawVariantTypeU8: return number(v.uiVal & 0xff);
		case blackmagicRawVariantTypeS16: return number(v.iVal);
		case blackmagicRawVariantTypeU16: return number(v.uiVal);
		case blackmagicRawVariantTypeS32: return number(v.intVal);
		case blackmagicRawVariantTypeU32: return number(v.uintVal);
		case blackmagicRawVariantTypeFloat32: return number(v.fltVal);
		case blackmagicRawVariantTypeFloat64: return number(v.dblVal);
		case blackmagicRawVariantTypeString: return v.bstrVal ? quote(text(v.bstrVal)) : "null";
		case blackmagicRawVariantTypeSafeArray: {
			COM::SafeArray* array = v.parray;
			void* data = nullptr; COM::VariantType type; long low = 0, high = -1;
			if (!array || FAILED(SafeArrayAccessData(array, &data)) || FAILED(SafeArrayGetVartype(array, &type)) || FAILED(SafeArrayGetLBound(array, 1, &low)) || FAILED(SafeArrayGetUBound(array, 1, &high))) return "null";
			const long length = high - low + 1;
			std::string out = "null";
			if (length >= 0 && length <= 64) {
				out = "[";
				for (long i = 0; i < length; i++) {
					if (i) out += ",";
					switch (type) {
						case blackmagicRawVariantTypeU8: out += number(((uint8_t*)data)[i]); break;
						case blackmagicRawVariantTypeS16: out += number(((int16_t*)data)[i]); break;
						case blackmagicRawVariantTypeU16: out += number(((uint16_t*)data)[i]); break;
						case blackmagicRawVariantTypeS32: out += number(((int32_t*)data)[i]); break;
						case blackmagicRawVariantTypeU32: out += number(((uint32_t*)data)[i]); break;
						case blackmagicRawVariantTypeFloat32: out += number(((float*)data)[i]); break;
						default: out += "null";
					}
				}
				out += "]";
			}
			SafeArrayUnaccessData(array);
			return out;
		}
		default: return "null";
	}
}

static std::string metadata(IBlackmagicRawMetadataIterator* iterator) {
	std::string out = "{";
	bool first = true;
	COM::NativeString key;
	while (SUCCEEDED(iterator->GetKey(&key))) {
		COM::Variant value; VariantInit(&value);
		if (SUCCEEDED(iterator->GetData(&value))) { out += (first ? "" : ",") + quote(text(key)) + ":" + json(value); first = false; }
		VariantClear(&value);
		if (iterator->Next() != S_OK) break;
	}
	return out + "}";
}

// --- codec ----------------------------------------------------------------------------------------------------------

struct Image { std::vector<uint8_t> bytes; uint32_t width = 0, height = 0; bool failed = false; };

class Callback : public IBlackmagicRawCallback {
public:
	IBlackmagicRawClipProcessingAttributes* clipAttributes = nullptr;
	std::vector<Setting>* frameSettings = nullptr;
	BlackmagicRawResolutionScale scale = blackmagicRawResolutionScaleFull;
	IBlackmagicRawFrame* firstFrame = nullptr;   // info: frame 0, kept
	std::mutex mutex;
	std::condition_variable ready;
	std::map<uint64_t, Image> done;

	virtual ~Callback() { if (firstFrame) firstFrame->Release(); }

	void finish(uint64_t index, Image image) { { std::lock_guard<std::mutex> lock(mutex); done[index] = std::move(image); } ready.notify_all(); }

	void ReadComplete(IBlackmagicRawJob* job, HRESULT result, IBlackmagicRawFrame* frame) override {
		uint64_t* index = nullptr;
		job->GetUserData((void**)&index);
		if (!index) { if (SUCCEEDED(result) && !firstFrame) { firstFrame = frame; frame->AddRef(); } return; }
		COM::OwningPtr<IBlackmagicRawFrameProcessingAttributes> frameAttributes;
		if (SUCCEEDED(result)) result = frame->SetResolutionScale(scale);
		if (SUCCEEDED(result)) result = frame->SetResourceFormat(blackmagicRawResourceFormatRGBU16);
		if (SUCCEEDED(result) && frameSettings && !frameSettings->empty()) {
			result = frame->CloneFrameProcessingAttributes(frameAttributes.outArg());
			for (Setting& s : *frameSettings) if (SUCCEEDED(result) && FAILED(frameAttributes->SetFrameAttribute(s.attribute->id, &s.value))) { std::fprintf(stderr, "braw: %s=%s was refused\n", s.attribute->key, s.text.c_str()); result = E_FAIL; }
		}
		COM::OwningPtr<IBlackmagicRawJob> process;
		if (SUCCEEDED(result)) result = frame->CreateJobDecodeAndProcessFrame(clipAttributes, frameAttributes, process.outArg());
		if (SUCCEEDED(result)) result = process->SetUserData(index);
		if (SUCCEEDED(result)) result = process->Submit();
		if (FAILED(result)) { Image failed; failed.failed = true; finish(*index, std::move(failed)); delete index; }
	}

	void ProcessComplete(IBlackmagicRawJob* job, HRESULT result, IBlackmagicRawProcessedImage* processed) override {
		uint64_t* index = nullptr;
		job->GetUserData((void**)&index);
		Image image;
		void* resource = nullptr; uint32_t size = 0; BlackmagicRawResourceType type = blackmagicRawResourceTypeBufferCPU;
		if (SUCCEEDED(result)) result = processed->GetResourceType(&type);
		if (SUCCEEDED(result) && type != blackmagicRawResourceTypeBufferCPU) result = E_FAIL;
		if (SUCCEEDED(result)) result = processed->GetWidth(&image.width);
		if (SUCCEEDED(result)) result = processed->GetHeight(&image.height);
		if (SUCCEEDED(result)) result = processed->GetResource(&resource);
		if (SUCCEEDED(result)) result = processed->GetResourceSizeBytes(&size);
		const size_t bytes = (size_t)image.width * image.height * 6;
		image.failed = FAILED(result) || size < bytes;
		if (!image.failed) image.bytes.assign((uint8_t*)resource, (uint8_t*)resource + bytes);
		if (index) { finish(*index, std::move(image)); delete index; }
	}

	void ReadAudioComplete(IBlackmagicRawJob*, HRESULT, IBlackmagicRawAudioBuffer*) override {}
	void DecodeComplete(IBlackmagicRawJob*, HRESULT) override {}
	void TrimProgress(IBlackmagicRawJob*, float) override {}
	void TrimComplete(IBlackmagicRawJob*, HRESULT) override {}
	void SidecarMetadataParseWarning(IBlackmagicRawClip*, COM::NativeString, uint32_t, COM::NativeString) override {}
	void SidecarMetadataParseError(IBlackmagicRawClip*, COM::NativeString, uint32_t, COM::NativeString) override {}
	void PreparePipelineComplete(void*, HRESULT) override {}

	HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, LPVOID* out) override {
		if (!out) return E_POINTER;
		if (iid == IID_IUnknown || iid == IID_IBlackmagicRawCallback) { *out = static_cast<IBlackmagicRawCallback*>(this); AddRef(); return S_OK; }
		*out = nullptr; return E_NOINTERFACE;
	}
	// Owned by main(): the codec only borrows it.
	ULONG STDMETHODCALLTYPE AddRef() override { return ++references; }
	ULONG STDMETHODCALLTYPE Release() override { return --references; }
private:
	std::atomic<ULONG> references = {1};
};

static BlackmagicRawResolutionScale scaleOf(const std::string& name) {
	if (name == "full") return blackmagicRawResolutionScaleFull;
	if (name == "half") return blackmagicRawResolutionScaleHalf;
	if (name == "quarter") return blackmagicRawResolutionScaleQuarter;
	if (name == "eighth") return blackmagicRawResolutionScaleEighth;
	fail("--scale is full, half, quarter or eighth");
	return blackmagicRawResolutionScaleFull;
}

// --- info -----------------------------------------------------------------------------------------------------------

template <typename Get> static std::string choices(Get get) {
	uint32_t count = 0; COM::Bool readOnly = false;
	if (FAILED(get(nullptr, &count, &readOnly)) || !count) return "[]";
	std::vector<COM::Variant> list(count);
	for (COM::Variant& v : list) VariantInit(&v);
	std::string out = "[";
	if (SUCCEEDED(get(list.data(), &count, &readOnly))) for (uint32_t i = 0; i < count; i++) out += (i ? "," : "") + json(list[i]);
	for (COM::Variant& v : list) VariantClear(&v);
	return out + "]";
}

static void info(IBlackmagicRawFactory* factory, IBlackmagicRaw* codec, IBlackmagicRawClip* clip, Callback& callback) {
	uint32_t width = 0, height = 0; float fps = 0; uint64_t frames = 0;
	check(clip->GetWidth(&width), "GetWidth"); check(clip->GetHeight(&height), "GetHeight");
	check(clip->GetFrameRate(&fps), "GetFrameRate"); check(clip->GetFrameCount(&frames), "GetFrameCount");
	COM::NativeString cameraNative = nullptr;
	clip->GetCameraType(&cameraNative);
	const std::string camera = cameraNative ? text(cameraNative) : "";

	std::string out = "{\"width\":" + number(width) + ",\"height\":" + number(height) + ",\"fps\":" + number(fps) + ",\"frames\":" + number((double)frames) + ",\"camera\":" + quote(camera);

	COM::OwningPtr<IBlackmagicRawConfiguration> configuration;
	if (SUCCEEDED(codec->QueryInterface(IID_IBlackmagicRawConfiguration, (void**)configuration.outArg()))) {
		COM::NativeString version = nullptr;
		if (SUCCEEDED(configuration->GetVersion(&version)) && version) out += ",\"sdk\":" + quote(text(version));
	}

	COM::OwningPtr<IBlackmagicRawClipResolutions> resolutions;
	if (SUCCEEDED(clip->QueryInterface(IID_IBlackmagicRawClipResolutions, (void**)resolutions.outArg()))) {
		out += ",\"scales\":{";
		const char* names[] = { "full", "half", "quarter", "eighth" };
		for (int i = 0; i < 4; i++) {
			uint32_t w = 0, h = 0;
			if (FAILED(resolutions->GetClosestResolutionForScale(scaleOf(names[i]), &w, &h))) w = h = 0;
			out += std::string(i ? "," : "") + quote(names[i]) + ":[" + number(w) + "," + number(h) + "]";
		}
		out += "}";
	}

	COM::OwningPtr<IBlackmagicRawMetadataIterator> clipMetadata;
	if (SUCCEEDED(clip->GetMetadataIterator(clipMetadata.outArg()))) out += ",\"metadata\":" + metadata(clipMetadata);

	COM::OwningPtr<IBlackmagicRawClipAudio> audio;
	if (SUCCEEDED(clip->QueryInterface(IID_IBlackmagicRawClipAudio, (void**)audio.outArg()))) {
		uint32_t channels = 0, rate = 0, bits = 0; uint64_t samples = 0;
		if (SUCCEEDED(audio->GetAudioChannelCount(&channels)) && channels) {
			audio->GetAudioSampleRate(&rate); audio->GetAudioBitDepth(&bits); audio->GetAudioSampleCount(&samples);
			out += ",\"audio\":{\"channels\":" + number(channels) + ",\"rate\":" + number(rate) + ",\"bits\":" + number(bits) + ",\"samples\":" + number((double)samples) + "}";
		}
	}

	// The clip's own settings, its choices and its ranges.
	COM::OwningPtr<IBlackmagicRawClipProcessingAttributes> clipAttributes;
	check(clip->CloneClipProcessingAttributes(clipAttributes.outArg()), "CloneClipProcessingAttributes");
	std::string settings = "{", ranges = "{";
	for (const Attribute& a : ATTRIBUTES) {
		if (!a.clip) continue;
		COM::Variant value; VariantInit(&value);
		if (SUCCEEDED(clipAttributes->GetClipAttribute(a.id, &value))) settings += (settings.size() > 1 ? "," : "") + quote(a.key) + ":" + json(value);
		VariantClear(&value);
		if (a.kind != Kind::Float) continue;
		COM::Variant low, high; VariantInit(&low); VariantInit(&high); COM::Bool readOnly = false;
		if (SUCCEEDED(clipAttributes->GetClipAttributeRange(a.id, &low, &high, &readOnly))) ranges += (ranges.size() > 1 ? "," : "") + quote(a.key) + ":[" + json(low) + "," + json(high) + "]";
		VariantClear(&low); VariantClear(&high);
	}
	auto list = [&](uint32_t id) { return choices([&](COM::Variant* array, uint32_t* count, COM::Bool* readOnly) { return clipAttributes->GetClipAttributeList(id, array, count, readOnly); }); };
	std::string options = "{\"viewing_bmdgen\":" + list(blackmagicRawClipProcessingAttributeColorScienceGen) + ",\"viewing_gamut\":" + list(blackmagicRawClipProcessingAttributeGamut)
		+ ",\"viewing_gamma\":" + list(blackmagicRawClipProcessingAttributeGamma) + ",\"post_3dlut_mode\":" + list(blackmagicRawClipProcessingAttributePost3DLUTMode);

	// Frame 0 holds the as-shot ISO, white balance and exposure, and the ISO list.
	{
		COM::OwningPtr<IBlackmagicRawJob> read;
		check(clip->CreateJobReadFrame(0, read.outArg()), "CreateJobReadFrame");
		check(read->Submit(), "Submit");
	}
	codec->FlushJobs();
	if (!callback.firstFrame) fail("could not read the first frame");
	COM::OwningPtr<IBlackmagicRawFrameProcessingAttributes> frameAttributes;
	check(callback.firstFrame->CloneFrameProcessingAttributes(frameAttributes.outArg()), "CloneFrameProcessingAttributes");
	for (const Attribute& a : ATTRIBUTES) {
		if (a.clip) continue;
		COM::Variant value; VariantInit(&value);
		if (SUCCEEDED(frameAttributes->GetFrameAttribute(a.id, &value))) settings += "," + quote(a.key) + ":" + json(value);
		VariantClear(&value);
		COM::Variant low, high; VariantInit(&low); VariantInit(&high); COM::Bool readOnly = false;
		if (a.id != blackmagicRawFrameProcessingAttributeISO && SUCCEEDED(frameAttributes->GetFrameAttributeRange(a.id, &low, &high, &readOnly))) ranges += (ranges.size() > 1 ? "," : "") + quote(a.key) + ":[" + json(low) + "," + json(high) + "]";
		VariantClear(&low); VariantClear(&high);
	}
	uint32_t isoCount = 0; COM::Bool isoReadOnly = false;
	std::string isos = "[";
	if (SUCCEEDED(frameAttributes->GetISOList(nullptr, &isoCount, &isoReadOnly)) && isoCount) {
		std::vector<uint32_t> values(isoCount);
		if (SUCCEEDED(frameAttributes->GetISOList(values.data(), &isoCount, &isoReadOnly))) for (uint32_t i = 0; i < isoCount; i++) isos += (i ? "," : "") + number(values[i]);
	}
	options += ",\"iso\":" + isos + "]}";
	COM::OwningPtr<IBlackmagicRawMetadataIterator> frameMetadata;
	std::string frameJson = "{}";
	if (SUCCEEDED(callback.firstFrame->GetMetadataIterator(frameMetadata.outArg()))) frameJson = metadata(frameMetadata);
	out += ",\"settings\":" + settings + "}" + ",\"ranges\":" + ranges + "}" + ",\"options\":" + options + ",\"frameMetadata\":" + frameJson;

	// What Film and Extended Video set the custom gamma sliders to, per science generation (the panel shows these).
	COM::OwningPtr<IBlackmagicRawToneCurve> toneCurve;
	if (SUCCEEDED(factory->QueryInterface(IID_IBlackmagicRawToneCurve, (void**)toneCurve.outArg())) || SUCCEEDED(codec->QueryInterface(IID_IBlackmagicRawToneCurve, (void**)toneCurve.outArg()))) {
		out += ",\"toneCurves\":{";
		bool first = true;
		for (uint16_t gen : { (uint16_t)4, (uint16_t)5, (uint16_t)6 }) for (const char* gamma : { "Blackmagic Design Film", "Blackmagic Design Extended Video" }) {
			float c, s, m, h, sh, b, w; uint16_t vb;
			COM::String cameraName(camera.c_str()), gammaName(gamma);
			if (FAILED(toneCurve->GetToneCurve(cameraName, gammaName, gen, &c, &s, &m, &h, &sh, &b, &w, &vb))) continue;
			out += std::string(first ? "" : ",") + quote(std::to_string(gen) + ":" + gamma) + ":{\"tone_curve_contrast\":" + number(c) + ",\"tone_curve_saturation\":" + number(s) + ",\"tone_curve_midpoint\":" + number(m)
				+ ",\"tone_curve_highlights\":" + number(h) + ",\"tone_curve_shadows\":" + number(sh) + ",\"tone_curve_black_level\":" + number(b) + ",\"tone_curve_white_level\":" + number(w) + ",\"tone_curve_video_black_level\":" + number(vb) + "}";
			first = false;
		}
		out += "}";
	}
	std::printf("%s}\n", out.c_str());
}

// --- decode ---------------------------------------------------------------------------------------------------------

static void decode(IBlackmagicRaw* codec, IBlackmagicRawClip* clip, Callback& callback, std::vector<Setting>& settings, BlackmagicRawResolutionScale scale, uint64_t start, uint64_t count, int inFlight) {
	uint64_t frames = 0;
	check(clip->GetFrameCount(&frames), "GetFrameCount");
	if (start >= frames) fail("--start is past the last frame");
	const uint64_t end = count > frames - start ? frames : start + count;

	COM::OwningPtr<IBlackmagicRawClipProcessingAttributes> clipAttributes;
	check(clip->CloneClipProcessingAttributes(clipAttributes.outArg()), "CloneClipProcessingAttributes");
	std::vector<Setting> frameSettings;
	for (Setting& s : settings) {
		if (!s.attribute->clip) { frameSettings.push_back(s); continue; }
		if (FAILED(clipAttributes->SetClipAttribute(s.attribute->id, &s.value))) fail(std::string(s.attribute->key) + "=" + s.text + " was refused");
	}
	callback.clipAttributes = clipAttributes;
	callback.frameSettings = &frameSettings;
	callback.scale = scale;

	uint64_t submitted = start;
	auto submit = [&]() {
		COM::OwningPtr<IBlackmagicRawJob> read;
		check(clip->CreateJobReadFrame(submitted, read.outArg()), "CreateJobReadFrame");
		uint64_t* index = new uint64_t(submitted);
		check(read->SetUserData(index), "SetUserData");
		if (FAILED(read->Submit())) { delete index; fail("could not read frame " + std::to_string(submitted)); }
		submitted++;
	};
	for (uint64_t next = start; next < end; next++) {
		while (submitted < end && submitted < next + (uint64_t)inFlight) submit();
		Image image;
		{
			std::unique_lock<std::mutex> lock(callback.mutex);
			callback.ready.wait(lock, [&] { return callback.done.count(next) > 0; });
			image = std::move(callback.done[next]);
			callback.done.erase(next);
		}
		if (image.failed) fail("could not decode frame " + std::to_string(next));
		if (next == start) std::fprintf(stderr, "size %ux%u\n", image.width, image.height);
		// A closed pipe (FFmpeg finished or was stopped) ends the run quietly.
		if (std::fwrite(image.bytes.data(), 1, image.bytes.size(), stdout) != image.bytes.size()) std::_Exit(0);
	}
	std::fflush(stdout);
	codec->FlushJobs();
}

int main(int argc, const char* argv[]) {
#ifdef _WIN32
	_setmode(_fileno(stdout), _O_BINARY);
#else
	std::signal(SIGPIPE, SIG_IGN);
#endif
	COM::Initialiser com;
	if (argc < 3) fail("usage: braw info|decode <clip> --lib <dir> [options]", 2);
	const std::string command = argv[1], clipPath = argv[2];
	std::string lib, scaleName = "full";
	uint64_t start = 0, count = UINT64_MAX;
	int threads = 0, inFlight = 4;
	std::vector<Setting> settings;
	for (int i = 3; i < argc; i++) {
		const std::string flag = argv[i];
		if (i + 1 >= argc) fail(flag + " needs a value", 2);
		const std::string value = argv[++i];
		if (flag == "--lib") lib = value;
		else if (flag == "--scale") scaleName = value;
		else if (flag == "--start") start = std::strtoull(value.c_str(), nullptr, 10);
		else if (flag == "--count") count = std::strtoull(value.c_str(), nullptr, 10);
		else if (flag == "--threads") threads = std::atoi(value.c_str());
		else if (flag == "--jobs") inFlight = std::max(1, std::atoi(value.c_str()));
		else if (flag == "--set") {
			const size_t equals = value.find('=');
			const Attribute* a = equals == std::string::npos ? nullptr : attribute(value.substr(0, equals));
			if (!a) fail("unknown setting " + value, 2);
			settings.emplace_back(a, value.substr(equals + 1));
		}
		else fail("unknown option " + flag, 2);
	}
	// Applied in table order, whatever order they came in.
	std::vector<Setting> ordered;
	for (const Attribute& a : ATTRIBUTES) for (Setting& s : settings) if (s.attribute == &a) ordered.push_back(s);
	if (lib.empty()) fail("--lib <folder holding the Blackmagic RAW library> is required", 2);

	COM::OwningPtr<IBlackmagicRawFactory> factory(CreateBlackmagicRawFactoryInstanceFromPath(COM::String(lib.c_str())));
	if (!factory) fail("could not load the Blackmagic RAW library from " + lib, 3);
	COM::OwningPtr<IBlackmagicRaw> codec;
	check(factory->CreateCodec(codec.outArg()), "CreateCodec");
	if (threads > 0) {
		COM::OwningPtr<IBlackmagicRawConfiguration> configuration;
		if (SUCCEEDED(codec->QueryInterface(IID_IBlackmagicRawConfiguration, (void**)configuration.outArg()))) configuration->SetCPUThreads((uint32_t)threads);
	}
	Callback callback;
	check(codec->SetCallback(&callback), "SetCallback");
	COM::OwningPtr<IBlackmagicRawClip> clip;
	if (FAILED(codec->OpenClip(COM::String(clipPath.c_str()), clip.outArg()))) fail("could not open " + clipPath + " as Blackmagic RAW", 4);

	if (command == "info") info(factory, codec, clip, callback);
	else if (command == "decode") decode(codec, clip, callback, ordered, scaleOf(scaleName), start, count, inFlight);
	else fail("unknown command " + command, 2);
	return 0;
}
