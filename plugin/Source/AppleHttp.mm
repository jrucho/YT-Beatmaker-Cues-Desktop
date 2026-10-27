#include "AppleHttp.h"
#import <Foundation/Foundation.h>

juce::File appleSharedLibraryDirectory(){
   #if JUCE_IOS && defined(BEATMAKER_APP_GROUP)
    @autoreleasepool {
        NSString* group=[NSString stringWithUTF8String:BEATMAKER_APP_GROUP];
        if(![group hasPrefix:@"group."])return {};
        NSURL* container=[[NSFileManager defaultManager] containerURLForSecurityApplicationGroupIdentifier:group];
        if(container)return juce::File(juce::String([[container path] UTF8String])).getChildFile("Beatmaker Cues/SharedLibrary");
    }
   #endif
    return {};
}
juce::String appleLibraryIdentity(){@autoreleasepool {return juce::String([[[NSBundle mainBundle] bundleIdentifier] UTF8String]);}}

AppleHttpResult appleHttp(const juce::String& url,const juce::String& method,const juce::String& headers,const juce::String& body,int timeoutSeconds,std::function<bool()> shouldCancel) {
    @autoreleasepool {
        AppleHttpResult result;
        NSURL* target=[NSURL URLWithString:[NSString stringWithUTF8String:url.toRawUTF8()]];
        if(!target)return result;
        NSMutableURLRequest* request=[NSMutableURLRequest requestWithURL:target];
        request.HTTPMethod=[NSString stringWithUTF8String:method.toRawUTF8()];
        request.timeoutInterval=timeoutSeconds;
        for(const auto& line:juce::StringArray::fromLines(headers)) {
            if(!line.containsChar(':'))continue;
            const auto key=line.upToFirstOccurrenceOf(":",false,false).trim();
            const auto value=line.fromFirstOccurrenceOf(":",false,false).trim();
            [request setValue:[NSString stringWithUTF8String:value.toRawUTF8()] forHTTPHeaderField:[NSString stringWithUTF8String:key.toRawUTF8()]];
        }
        if(body.isNotEmpty())request.HTTPBody=[[NSString stringWithUTF8String:body.toRawUTF8()] dataUsingEncoding:NSUTF8StringEncoding];
        static NSURLSession* session=nil;
        static dispatch_once_t once;
        dispatch_once(&once, ^{
            NSURLSessionConfiguration* configuration=[NSURLSessionConfiguration ephemeralSessionConfiguration];
            configuration.timeoutIntervalForResource=30;
            configuration.HTTPMaximumConnectionsPerHost=4;
            configuration.HTTPShouldSetCookies=NO;
            session=[[NSURLSession sessionWithConfiguration:configuration] retain];
        });
        dispatch_semaphore_t semaphore=dispatch_semaphore_create(0);
        __block NSData* responseData=nil;
        __block NSHTTPURLResponse* httpResponse=nil;
        NSURLSessionDataTask* task=[session dataTaskWithRequest:request completionHandler:^(NSData* data,NSURLResponse* response,NSError*) {
            responseData=[data retain];httpResponse=[(NSHTTPURLResponse*)response retain];dispatch_semaphore_signal(semaphore);
        }];
        [task resume];
        const auto deadline=juce::Time::getMillisecondCounterHiRes()+(timeoutSeconds+1)*1000;
        bool cancelled=false;
        while(dispatch_semaphore_wait(semaphore,dispatch_time(DISPATCH_TIME_NOW,50*NSEC_PER_MSEC))!=0){
            if((shouldCancel&&shouldCancel())||juce::Time::getMillisecondCounterHiRes()>deadline){cancelled=true;[task cancel];dispatch_semaphore_wait(semaphore,DISPATCH_TIME_FOREVER);break;}
        }
        if(!cancelled&&httpResponse){
            result.status=(int)httpResponse.statusCode;
            for(NSString* key in httpResponse.allHeaderFields)result.headers.set(juce::String([key UTF8String]),juce::String([[httpResponse.allHeaderFields[key] description] UTF8String]));
            if(responseData)result.data.append(responseData.bytes,responseData.length);
        }
        [responseData release];[httpResponse release];
        return result;
    }
}
