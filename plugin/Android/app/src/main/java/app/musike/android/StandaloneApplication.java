package app.musike.android;
public final class StandaloneApplication extends com.rmsl.juce.JuceApp {
    @Override public void onCreate() { StandaloneBridge.initialise(this); super.onCreate(); StandaloneBridge.bind(this); }
}
