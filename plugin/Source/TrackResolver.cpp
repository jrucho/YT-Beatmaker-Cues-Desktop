#include "TrackResolver.h"
#if JUCE_MAC || JUCE_IOS
#include "AppleHttp.h"
#endif
#include <stdexcept>

namespace {
juce::var object(std::initializer_list<std::pair<juce::Identifier,juce::var>> fields){auto* data=new juce::DynamicObject;for(const auto& field:fields)data->setProperty(field.first,field.second);return juce::var(data);}
constexpr auto userAgent="Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
juce::var post(const juce::String& endpoint,const juce::var& body,const char* clientId,const char* version,const std::function<bool()>& cancelled){
    if(cancelled())throw std::runtime_error("Track resolution cancelled");
    const auto url="https://www.youtube.com/youtubei/v1/"+endpoint;
    const auto headers="Content-Type: application/json\r\nOrigin: https://www.youtube.com\r\nUser-Agent: "+juce::String(userAgent)+"\r\nX-YouTube-Client-Name: "+clientId+"\r\nX-YouTube-Client-Version: "+version+"\r\nX-Goog-Api-Format-Version: 2\r\n";
    const auto payload=juce::JSON::toString(body,true);
   #if JUCE_MAC || JUCE_IOS
    const auto response=appleHttp(url,"POST",headers,payload,12,cancelled);
    if(response.status!=200)throw std::runtime_error("YouTube did not return a player response");
    return juce::JSON::parse(juce::String::fromUTF8((const char*)response.data.getData(),(int)response.data.getSize()));
   #else
    int status=0;auto stream=juce::URL::createWithoutParsing(url).withPOSTData(payload).createInputStream(juce::URL::InputStreamOptions(juce::URL::ParameterHandling::inPostData).withHttpRequestCmd("POST").withExtraHeaders(headers).withConnectionTimeoutMs(12000).withStatusCode(&status));
    if(!stream||status!=200)throw std::runtime_error("YouTube did not return a player response");
    return juce::JSON::parse(stream->readEntireStreamAsString());
   #endif
}
}
juce::var resolveYouTubeTrack(const juce::String& id,const std::function<bool()>& cancelled){
    if(id.length()!=11||!id.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"))throw std::runtime_error("Invalid track ID");
    const auto client=[](const char* name,const char* version){return object({{"clientName",name},{"clientVersion",version},{"hl","en"},{"gl","US"},{"platform","DESKTOP"},{"userAgent",juce::String(userAgent)+",gzip(gfe)"}});};
    juce::String visitor;
    try{const auto response=post("visitor_id?prettyPrint=false",object({{"context",object({{"client",client("VISIONOS","1.02")}})}}),"101","1.02",cancelled);visitor=response["responseContext"]["visitorData"].toString();}catch(...){if(cancelled())throw;}
    struct Client {const char* name;const char* version;const char* number;};
    for(const auto selected:{Client{"VISIONOS","1.02","101"},Client{"ANDROID_VR","1.60.19","28"},Client{"IOS","20.10.4","5"}}){
        try{
            auto details=client(selected.name,selected.version);details.getDynamicObject()->setProperty("visitorData",visitor);details.getDynamicObject()->setProperty("originalUrl","https://www.youtube.com/watch?v="+id);
            const auto response=post("player?prettyPrint=false&alt=json",object({{"videoId",id},{"racyCheckOk",true},{"contentCheckOk",true},{"context",object({{"client",details}})},
                {"playbackContext",object({{"contentPlaybackContext",object({{"html5Preference","HTML5_PREF_WANTS"}})}})}}),selected.number,selected.version,cancelled);
            if(response["playabilityStatus"]["status"].toString()!="OK")continue;
            juce::var best;int bitrate=-1;
            if(const auto* formats=response["streamingData"]["adaptiveFormats"].getArray())for(const auto& format:*formats)
                if(format["url"].toString().isNotEmpty()&&format["mimeType"].toString().startsWith("audio/mp4")&&(int)format["bitrate"]>bitrate){best=format;bitrate=(int)format["bitrate"];}
            if(!best.isVoid())return object({{"url",best["url"]},{"mime",best["mimeType"]},{"title",response["videoDetails"]["title"]},{"duration",response["videoDetails"]["lengthSeconds"].toString().getDoubleValue()}});
        }catch(...){if(cancelled())throw;}
    }
    throw std::runtime_error("No playable audio is available for this track");
}
