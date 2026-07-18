#include <ApplicationServices/ApplicationServices.h>
#include <AppKit/AppKit.h>
#include <CoreAudio/CoreAudio.h>
#include <IOKit/hidsystem/IOLLEvent.h>
#include <IOKit/hidsystem/ev_keymap.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

enum {
  KEY_S = 0x01,
  KEY_D = 0x02,
  KEY_O = 0x1F,
  KEY_RETURN = 0x24,
  KEY_TAB = 0x30,
  KEY_COMMAND = 0x37,
  KEY_SHIFT = 0x38,
  KEY_OPTION = 0x3A,
  KEY_CONTROL = 0x3B
};

enum {
  MEDIA_SOUND_UP = 0,
  MEDIA_SOUND_DOWN = 1,
  MEDIA_MUTE = 7,
  MEDIA_PLAY_PAUSE = 16,
  MEDIA_NEXT = 17,
  MEDIA_PREVIOUS = 18,
  MEDIA_FAST_FORWARD = 19,
  MEDIA_REWIND = 20
};

static void post_key(CGKeyCode key, bool down, CGEventFlags flags) {
  CGEventRef event = CGEventCreateKeyboardEvent(NULL, key, down);
  if (event == NULL) return;
  CGEventSetFlags(event, flags);
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
  usleep(9000);
}

static void voice_down(void) {
  post_key(KEY_CONTROL, true, kCGEventFlagMaskControl);
  post_key(KEY_SHIFT, true, kCGEventFlagMaskControl | kCGEventFlagMaskShift);
  post_key(KEY_D, true, kCGEventFlagMaskControl | kCGEventFlagMaskShift);
}

static void voice_up(void) {
  post_key(KEY_D, false, kCGEventFlagMaskControl | kCGEventFlagMaskShift);
  post_key(KEY_SHIFT, false, kCGEventFlagMaskControl);
  post_key(KEY_CONTROL, false, 0);
}

static void tap_key(CGKeyCode key, CGEventFlags flags) {
  post_key(key, true, flags);
  post_key(key, false, flags);
}

static void post_media_key(int key, bool down) {
  @autoreleasepool {
    NSEvent *event = [NSEvent
      otherEventWithType:NSEventTypeSystemDefined
      location:NSZeroPoint
      modifierFlags:0
      timestamp:0
      windowNumber:0
      context:nil
      subtype:NX_SUBTYPE_AUX_CONTROL_BUTTONS
      data1:(key << 16) | ((down ? 0x0A : 0x0B) << 8)
      data2:-1
    ];
    if (event == nil || event.CGEvent == NULL) return;
    CGEventPost(kCGHIDEventTap, event.CGEvent);
    usleep(9000);
  }
}

static void tap_media_key(int key) {
  post_media_key(key, true);
  post_media_key(key, false);
}

static void print_running_audio_processes(void) {
  AudioObjectPropertyAddress address = {
    kAudioHardwarePropertyProcessObjectList,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size) != noErr) return;
  AudioObjectID *processes = malloc(size);
  if (processes == NULL) return;
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, processes) != noErr) {
    free(processes);
    return;
  }

  UInt32 count = size / sizeof(AudioObjectID);
  for (UInt32 index = 0; index < count; index += 1) {
    UInt32 is_running = 0;
    UInt32 value_size = sizeof(is_running);
    address.mSelector = kAudioProcessPropertyIsRunningOutput;
    if (AudioObjectGetPropertyData(processes[index], &address, 0, NULL, &value_size, &is_running) != noErr || !is_running) continue;

    pid_t pid = 0;
    value_size = sizeof(pid);
    address.mSelector = kAudioProcessPropertyPID;
    AudioObjectGetPropertyData(processes[index], &address, 0, NULL, &value_size, &pid);

    CFStringRef bundle_id = NULL;
    value_size = sizeof(bundle_id);
    address.mSelector = kAudioProcessPropertyBundleID;
    AudioObjectGetPropertyData(processes[index], &address, 0, NULL, &value_size, &bundle_id);
    char bundle[512] = "";
    if (bundle_id != NULL) {
      CFStringGetCString(bundle_id, bundle, sizeof(bundle), kCFStringEncodingUTF8);
      CFRelease(bundle_id);
    }
    printf("%d\t%s\n", pid, bundle);
  }
  free(processes);
}

static void app_switch(void) {
  post_key(KEY_COMMAND, true, kCGEventFlagMaskCommand);
  tap_key(KEY_TAB, kCGEventFlagMaskCommand);
  post_key(KEY_COMMAND, false, 0);
}

static void new_thread(void) {
  post_key(KEY_COMMAND, true, kCGEventFlagMaskCommand);
  post_key(KEY_OPTION, true, kCGEventFlagMaskCommand | kCGEventFlagMaskAlternate);
  tap_key(KEY_O, kCGEventFlagMaskCommand | kCGEventFlagMaskAlternate);
  post_key(KEY_OPTION, false, kCGEventFlagMaskCommand);
  post_key(KEY_COMMAND, false, 0);
}

static void side_chat(void) {
  post_key(KEY_COMMAND, true, kCGEventFlagMaskCommand);
  post_key(KEY_OPTION, true, kCGEventFlagMaskCommand | kCGEventFlagMaskAlternate);
  tap_key(KEY_S, kCGEventFlagMaskCommand | kCGEventFlagMaskAlternate);
  post_key(KEY_OPTION, false, kCGEventFlagMaskCommand);
  post_key(KEY_COMMAND, false, 0);
}

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  if (strcmp(argv[1], "preflight") == 0) {
    bool trusted = CGPreflightPostEventAccess();
    printf("%d\n", trusted ? 1 : 0);
    return trusted ? 0 : 77;
  }
  if (strcmp(argv[1], "selftest") == 0) {
    voice_down();
    usleep(30000);
    bool held = CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, KEY_CONTROL)
      && CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, KEY_SHIFT)
      && CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, KEY_D);
    voice_up();
    usleep(30000);
    bool released = !CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, KEY_CONTROL)
      && !CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, KEY_SHIFT)
      && !CGEventSourceKeyState(kCGEventSourceStateHIDSystemState, KEY_D);
    printf("held=%d released=%d\n", held ? 1 : 0, released ? 1 : 0);
    return held && released ? 0 : 1;
  }
  if (strcmp(argv[1], "voice-down") == 0) voice_down();
  else if (strcmp(argv[1], "voice-up") == 0) voice_up();
  else if (strcmp(argv[1], "send") == 0) tap_key(KEY_RETURN, 0);
  else if (strcmp(argv[1], "app-switch") == 0) app_switch();
  else if (strcmp(argv[1], "new-thread") == 0) new_thread();
  else if (strcmp(argv[1], "side-chat") == 0) side_chat();
  else if (strcmp(argv[1], "media-previous") == 0) tap_media_key(MEDIA_PREVIOUS);
  else if (strcmp(argv[1], "media-rewind") == 0) tap_media_key(MEDIA_REWIND);
  else if (strcmp(argv[1], "media-play-pause") == 0) tap_media_key(MEDIA_PLAY_PAUSE);
  else if (strcmp(argv[1], "media-forward") == 0) tap_media_key(MEDIA_FAST_FORWARD);
  else if (strcmp(argv[1], "media-mute") == 0) tap_media_key(MEDIA_MUTE);
  else if (strcmp(argv[1], "media-volume-down") == 0) tap_media_key(MEDIA_SOUND_DOWN);
  else if (strcmp(argv[1], "media-volume-up") == 0) tap_media_key(MEDIA_SOUND_UP);
  else if (strcmp(argv[1], "media-next") == 0) tap_media_key(MEDIA_NEXT);
  else if (strcmp(argv[1], "audio-processes") == 0) print_running_audio_processes();
  else if (strcmp(argv[1], "release") == 0) voice_up();
  else return 64;
  return 0;
}
