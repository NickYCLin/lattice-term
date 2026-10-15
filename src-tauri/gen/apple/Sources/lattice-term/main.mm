#include "bindings/bindings.h"
#include <TargetConditionals.h>

#if TARGET_OS_SIMULATOR
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>

static NSDictionary *layoutRect(CGRect rect) {
    return @{ @"x": @(rect.origin.x), @"y": @(rect.origin.y),
              @"width": @(rect.size.width), @"height": @(rect.size.height) };
}

static NSDictionary *layoutInsets(UIEdgeInsets insets) {
    return @{ @"top": @(insets.top), @"bottom": @(insets.bottom),
              @"left": @(insets.left), @"right": @(insets.right) };
}

static NSArray *layoutChildren(UIView *view) {
    NSMutableArray *children = [NSMutableArray array];
    for (UIView *child in view.subviews) {
        [children addObject:@{ @"class": NSStringFromClass(child.class),
            @"frame": layoutRect(child.frame), @"bounds": layoutRect(child.bounds),
            @"children": layoutChildren(child) }];
    }
    return children;
}

static NSString *applyLayoutExperiment(WKWebView *webview) {
    NSURL *cache = [[[NSFileManager defaultManager] URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask] firstObject];
    NSString *variant = [NSString stringWithContentsOfURL:[cache URLByAppendingPathComponent:@"layout-variant.txt"] encoding:NSUTF8StringEncoding error:nil] ?: @"baseline";
    static NSString *previous = @"baseline";
    if (![variant isEqualToString:previous]) {
        if ([variant isEqualToString:@"never"]) {
            webview.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
        } else if ([variant isEqualToString:@"automatic"]) {
            webview.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentAutomatic;
        } else if ([variant isEqualToString:@"zero-insets"]) {
            if (@available(iOS 15.5, *)) {
                [webview setMinimumViewportInset:UIEdgeInsetsZero maximumViewportInset:UIEdgeInsetsZero];
            }
        } else if ([variant isEqualToString:@"resize"]) {
            CGRect frame = webview.frame;
            webview.frame = CGRectInset(frame, 0, 1);
            webview.frame = frame;
        }
        previous = [variant copy];
    }
    return previous;
}

static void captureLayout(UIView *view, UIWindow *window, NSInteger seconds, NSInteger *index) {
    if ([view isKindOfClass:[WKWebView class]]) {
        WKWebView *webview = (WKWebView *)view;
        NSString *variant = applyLayoutExperiment(webview);
        NSMutableDictionary *snapshot = [@{
            @"variant": variant,
            @"delaySeconds": @(seconds), @"windowBounds": layoutRect(window.bounds),
            @"capturedAt": @([[NSDate date] timeIntervalSince1970]),
            @"screenBounds": layoutRect(window.screen.bounds), @"scale": @(window.screen.scale),
            @"windowSafeArea": layoutInsets(window.safeAreaInsets),
            @"webviewFrame": layoutRect(webview.frame),
            @"webviewInWindow": layoutRect([webview convertRect:webview.bounds toView:window]),
            @"webviewSafeArea": layoutInsets(webview.safeAreaInsets),
            @"scrollFrame": layoutRect(webview.scrollView.frame),
            @"scrollBounds": layoutRect(webview.scrollView.bounds),
            @"scrollContentSize": @{ @"width": @(webview.scrollView.contentSize.width), @"height": @(webview.scrollView.contentSize.height) },
            @"insetAdjustmentBehavior": @(webview.scrollView.contentInsetAdjustmentBehavior),
            @"children": layoutChildren(webview),
            @"contentInset": layoutInsets(webview.scrollView.contentInset),
            @"adjustedContentInset": layoutInsets(webview.scrollView.adjustedContentInset)
        } mutableCopy];
        if (@available(iOS 15.5, *)) {
            snapshot[@"minimumViewportInset"] = layoutInsets(webview.minimumViewportInset);
            snapshot[@"maximumViewportInset"] = layoutInsets(webview.maximumViewportInset);
        }
        NSString *name = [NSString stringWithFormat:@"layout-%ld-%ld.json", (long)seconds, (long)(*index)++];
        NSString *script = @"JSON.stringify({innerWidth,innerHeight,devicePixelRatio,viewportMeta:Array.from(document.querySelectorAll('meta[name=viewport]'),n=>n.content),screen:{width:screen.width,height:screen.height},viewport:visualViewport?{width:visualViewport.width,height:visualViewport.height,offsetTop:visualViewport.offsetTop,scale:visualViewport.scale}:null,rects:['html','body','#root','.app--mobile'].map(selector=>{const n=document.querySelector(selector);if(!n)return {selector};const r=n.getBoundingClientRect();const c=getComputedStyle(n);return {selector,x:r.x,y:r.y,width:r.width,height:r.height,background:c.backgroundColor,position:c.position,cssHeight:c.height,viewportHeight:c.getPropertyValue('--app-viewport-height')}})})";
        [webview evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
            if ([result isKindOfClass:[NSString class]]) {
                snapshot[@"dom"] = [NSJSONSerialization JSONObjectWithData:[result dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil] ?: @{};
            }
            if (error) snapshot[@"javascriptErrorCode"] = @(error.code);
            NSURL *cache = [[[NSFileManager defaultManager] URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask] firstObject];
            NSData *data = [NSJSONSerialization dataWithJSONObject:snapshot options:NSJSONWritingPrettyPrinted error:nil];
            [data writeToURL:[cache URLByAppendingPathComponent:name] options:NSDataWritingAtomic error:nil];
        }];
    }
    for (UIView *child in view.subviews) captureLayout(child, window, seconds, index);
}

static void scheduleLayoutDiagnostics(void) {
    if (![[NSProcessInfo processInfo].environment[@"LATTICETERM_LAYOUT_DIAGNOSTICS"] isEqualToString:@"1"]) return;
    NSMutableArray<NSNumber *> *delays = [NSMutableArray arrayWithObject:@2];
    for (NSInteger seconds = 5; seconds <= 900; seconds += 5) [delays addObject:@(seconds)];
    for (NSNumber *delay in delays) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, delay.longLongValue * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            NSInteger index = 0;
            for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
                if (![scene isKindOfClass:[UIWindowScene class]]) continue;
                for (UIWindow *window in ((UIWindowScene *)scene).windows) {
                    captureLayout(window, window, delay.integerValue, &index);
                }
            }
        });
    }
}
#endif

int main(int argc, char * argv[]) {
#if TARGET_OS_SIMULATOR
	scheduleLayoutDiagnostics();
#endif
	ffi::start_app();
	return 0;
}
