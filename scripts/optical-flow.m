#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <VideoToolbox/VideoToolbox.h>

static void require(BOOL ok, NSString *message) {
    if (!ok) @throw [NSException exceptionWithName:@"OpticalFlow" reason:message ?: @"Native video processing failed" userInfo:nil];
}

// Sample luma on a small grid: reject hard cuts instead of morphing unrelated shots.
static BOOL sceneCut(CVPixelBufferRef a, CVPixelBufferRef b) {
    CVPixelBufferLockBaseAddress(a, kCVPixelBufferLock_ReadOnly);
    CVPixelBufferLockBaseAddress(b, kCVPixelBufferLock_ReadOnly);
    size_t w = CVPixelBufferGetWidth(a), h = CVPixelBufferGetHeight(a);
    uint16_t *pa = CVPixelBufferGetBaseAddressOfPlane(a, 0), *pb = CVPixelBufferGetBaseAddressOfPlane(b, 0);
    size_t sa = CVPixelBufferGetBytesPerRowOfPlane(a, 0)/2, sb = CVPixelBufferGetBytesPerRowOfPlane(b, 0)/2;
    double difference = 0; int count = 0;
    for (size_t y = 0; y < h; y += MAX(1,h/32)) for (size_t x = 0; x < w; x += MAX(1,w/32)) {
        difference += fabs((double)pa[y*sa+x] - pb[y*sb+x])/65535; count++;
    }
    CVPixelBufferUnlockBaseAddress(a, kCVPixelBufferLock_ReadOnly);
    CVPixelBufferUnlockBaseAddress(b, kCVPixelBufferLock_ReadOnly);
    // ponytail: conservative luma cut detector; motion-compensated confidence if cut tests expose misses.
    return difference / MAX(1,count) > .30;
}

int main(int argc, const char *argv[]) { @autoreleasepool { @try {
    if (@available(macOS 15.4, *)) {
        require(VTFrameRateConversionConfiguration.isSupported, @"Optical flow requires a supported Apple silicon Mac.");
        if (argc == 2 && strcmp(argv[1], "--check") == 0) { puts("Apple VideoToolbox · quality priority"); return 0; }
        require(argc == 2, @"Expected a retiming job JSON file.");
        NSError *error = nil;
        NSDictionary *job = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfFile:@(argv[1])] options:0 error:&error];
        require(job != nil, error.localizedDescription);
        NSArray<NSDictionary *> *frames = job[@"frames"];
        double fps = [job[@"fps"] doubleValue];
        require(frames.count > 0 && frames.count <= 2592000 && fps >= 1 && fps <= 120, @"Invalid output frame schedule.");
        AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:job[@"input"]] options:nil];
        AVAssetTrack *track = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
        require(track != nil, @"The Mac could not decode the source video.");
        CMFormatDescriptionRef format = (__bridge CMFormatDescriptionRef)track.formatDescriptions.firstObject;
        CMVideoDimensions dimensions = CMVideoFormatDescriptionGetDimensions(format);
        VTFrameRateConversionConfiguration *configuration = [[VTFrameRateConversionConfiguration alloc] initWithFrameWidth:dimensions.width frameHeight:dimensions.height usePrecomputedFlow:NO qualityPrioritization:VTFrameRateConversionConfigurationQualityPrioritizationQuality revision:VTFrameRateConversionConfiguration.defaultRevision];
        require(configuration != nil, @"Video dimensions are unsupported by optical flow.");
        VTFrameProcessor *processor = [VTFrameProcessor new];
        require([processor startSessionWithConfiguration:configuration error:&error], error.localizedDescription);
        NSMutableDictionary *attributes = [configuration.sourcePixelBufferAttributes mutableCopy];
        attributes[(id)kCVPixelBufferPixelFormatTypeKey] = @(kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange);
        attributes[(id)kCVPixelBufferIOSurfacePropertiesKey] = @{};
        NSMutableDictionary *destAttributes = [configuration.destinationPixelBufferAttributes mutableCopy];
        destAttributes[(id)kCVPixelBufferIOSurfacePropertiesKey] = @{};
        destAttributes[(id)kCVPixelBufferPixelFormatTypeKey] = @(kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange);
        destAttributes[(id)kCVPixelBufferWidthKey] = @(dimensions.width);
        destAttributes[(id)kCVPixelBufferHeightKey] = @(dimensions.height);
        CVPixelBufferPoolRef pool = NULL;
        require(CVPixelBufferPoolCreate(kCFAllocatorDefault,NULL,(__bridge CFDictionaryRef)destAttributes,&pool) == kCVReturnSuccess, @"Could not create the optical-flow buffer pool.");
        __block AVAssetReader *reader;
        __block AVAssetReaderTrackOutput *output;
        void (^seek)(double) = ^(double time) {
            [reader cancelReading]; NSError *readError = nil;
            reader = [[AVAssetReader alloc] initWithAsset:asset error:&readError];
            output = [[AVAssetReaderTrackOutput alloc] initWithTrack:track outputSettings:attributes];
            output.alwaysCopiesSampleData = NO;
            require([reader canAddOutput:output], @"Could not configure the source decoder.");
            [reader addOutput:output];
            double begin = MAX(0,time - 2.0/MAX(1,track.nominalFrameRate));
            reader.timeRange = CMTimeRangeMake(CMTimeMakeWithSeconds(begin,600000), kCMTimePositiveInfinity);
            require([reader startReading], reader.error.localizedDescription);
        };
        NSURL *destination = [NSURL fileURLWithPath:job[@"output"]];
        AVAssetWriter *writer = [[AVAssetWriter alloc] initWithURL:destination fileType:AVFileTypeQuickTimeMovie error:&error];
        AVAssetWriterInput *input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:@{AVVideoCodecKey:AVVideoCodecTypeAppleProRes422HQ, AVVideoWidthKey:@(dimensions.width), AVVideoHeightKey:@(dimensions.height)}];
        input.transform = track.preferredTransform;
        AVAssetWriterInputPixelBufferAdaptor *adaptor = [AVAssetWriterInputPixelBufferAdaptor assetWriterInputPixelBufferAdaptorWithAssetWriterInput:input sourcePixelBufferAttributes:attributes];
        require([writer canAddInput:input], @"Could not configure the retimed video encoder.");
        [writer addInput:input];
        require([writer startWriting], writer.error.localizedDescription);
        [writer startSessionAtSourceTime:kCMTimeZero];
        CMSampleBufferRef left = NULL, right = NULL;
        double previousPair = -1, processedA = -1, processedB = -1; BOOL cut = NO; NSUInteger synthesized = 0, cuts = 0;
        for (NSUInteger i = 0; i < frames.count; i++) { @autoreleasepool {
            double time = [frames[i][@"time"] doubleValue];
            require(isfinite(time) && time >= 0, @"Invalid source time.");
            // ponytail: forward ramps decode once; reverse uses bounded seeks. Add a reverse frame window if throughput matters.
            if (!left || time + 1e-7 < CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(left))) {
                if (left) CFRelease(left); if (right) CFRelease(right);
                seek(time); left = [output copyNextSampleBuffer]; right = [output copyNextSampleBuffer]; previousPair = -1;
            }
            while (right && CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(right)) <= time + 1e-7) {
                CFRelease(left); left = right; right = [output copyNextSampleBuffer];
            }
            require(left != NULL && reader.status != AVAssetReaderStatusFailed, reader.error.localizedDescription ?: @"No source frame at the requested time.");
            CVPixelBufferRef picture = CMSampleBufferGetImageBuffer(left), generated = NULL;
            double a = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(left));
            double b = right ? CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(right)) : a;
            double phase = b > a ? (time-a)/(b-a) : 0;
            if (right && phase > 1e-5 && phase < 1-1e-5 && [frames[i][@"interpolate"] boolValue]) {
                if (a != previousPair) { cut = sceneCut(picture,CMSampleBufferGetImageBuffer(right)); if (cut) cuts++; }
                if (!cut) {
                    require(CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault,pool,&generated) == kCVReturnSuccess, @"Could not allocate an optical-flow frame.");
                    CVBufferPropagateAttachments(picture, generated);
                    VTFrameProcessorFrame *sourceFrame = [[VTFrameProcessorFrame alloc] initWithBuffer:picture presentationTimeStamp:CMSampleBufferGetPresentationTimeStamp(left)];
                    VTFrameProcessorFrame *nextFrame = [[VTFrameProcessorFrame alloc] initWithBuffer:CMSampleBufferGetImageBuffer(right) presentationTimeStamp:CMSampleBufferGetPresentationTimeStamp(right)];
                    VTFrameProcessorFrame *destinationFrame = [[VTFrameProcessorFrame alloc] initWithBuffer:generated presentationTimeStamp:CMTimeMakeWithSeconds(time,600000)];
                    VTFrameRateConversionParametersSubmissionMode mode = a == processedA && b == processedB ? VTFrameRateConversionParametersSubmissionModeSequentialReferencesUnchanged : fabs(a-processedB)<1e-7 ? VTFrameRateConversionParametersSubmissionModeSequential : VTFrameRateConversionParametersSubmissionModeRandom;
                    VTFrameRateConversionParameters *parameters = [[VTFrameRateConversionParameters alloc] initWithSourceFrame:sourceFrame nextFrame:nextFrame opticalFlow:nil interpolationPhase:@[@(phase)] submissionMode:mode destinationFrames:@[destinationFrame]];
                    require(parameters && [processor processWithParameters:parameters error:&error], error.localizedDescription);
                    processedA = a; processedB = b;
                    picture = generated; synthesized++;
                }
                previousPair = a;
            }
            while (!input.readyForMoreMediaData && writer.status == AVAssetWriterStatusWriting) [NSThread sleepForTimeInterval:.002];
            require([adaptor appendPixelBuffer:picture withPresentationTime:CMTimeMakeWithSeconds(i/fps,600000)], writer.error.localizedDescription);
            if (generated) CFRelease(generated);
            if (i % 12 == 0) { printf("{\"progress\":%.1f}\n", 95.0*(i+1)/frames.count); fflush(stdout); }
        }}
        if (left) CFRelease(left); if (right) CFRelease(right);
        [reader cancelReading]; [processor endSession];
        [writer endSessionAtSourceTime:CMTimeMakeWithSeconds(frames.count/fps,600000)];
        [input markAsFinished];
        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        [writer finishWritingWithCompletionHandler:^{ dispatch_semaphore_signal(done); }];
        dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
        require(writer.status == AVAssetWriterStatusCompleted, writer.error.localizedDescription);
        CFRelease(pool);
        printf("{\"progress\":100,\"synthesized\":%lu,\"sceneCuts\":%lu}\n", synthesized, cuts);
        return 0;
    }
    require(NO, @"Optical flow requires macOS 15.4 or newer.");
} @catch (NSException *exception) { fprintf(stderr, "%s\n", exception.reason.UTF8String); return 1; } return 1; }}
