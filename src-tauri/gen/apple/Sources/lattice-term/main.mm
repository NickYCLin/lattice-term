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

static void captureLayout(UIView *view, UIWindow *window, NSInteger seconds, NSInteger *index) {
    if ([view isKindOfClass:[WKWebView class]]) {
        WKWebView *webview = (WKWebView *)view;
        NSMutableDictionary *snapshot = [@{
            @"delaySeconds": @(seconds), @"windowBounds": layoutRect(window.bounds),
            @"screenBounds": layoutRect(window.screen.bounds), @"scale": @(window.screen.scale),
            @"windowSafeArea": layoutInsets(window.safeAreaInsets),
            @"webviewFrame": layoutRect(webview.frame),
            @"webviewInWindow": layoutRect([webview convertRect:webview.bounds toView:window]),
            @"webviewSafeArea": layoutInsets(webview.safeAreaInsets),
            @"scrollFrame": layoutRect(webview.scrollView.frame),
            @"contentInset": layoutInsets(webview.scrollView.contentInset),
            @"adjustedContentInset": layoutInsets(webview.scrollView.adjustedContentInset)
        } mutableCopy];
        NSString *name = [NSString stringWithFormat:@"layout-%ld-%ld.json", (long)seconds, (long)(*index)++];
        NSString *script = @"JSON.stringify({innerWidth,innerHeight,devicePixelRatio,viewport:visualViewport?{width:visualViewport.width,height:visualViewport.height,offsetTop:visualViewport.offsetTop,scale:visualViewport.scale}:null,rects:['html','body','#root','.app--mobile'].map(selector=>{const n=document.querySelector(selector);if(!n)return {selector};const r=n.getBoundingClientRect();const c=getComputedStyle(n);return {selector,x:r.x,y:r.y,width:r.width,height:r.height,background:c.backgroundColor,position:c.position,cssHeight:c.height,viewportHeight:c.getPropertyValue('--app-viewport-height')}})})";
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
    for (NSNumber *delay in @[@2, @10]) {
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
