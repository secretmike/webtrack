from urllib2 import urlopen
from urllib import urlretrieve
from urlparse import urljoin
from subprocess import check_output, check_call, Popen, PIPE
from multiprocessing import Process, Queue
from tempfile import mkdtemp
from base64 import b64encode
from uuid import uuid4
from signal import SIGTERM
import os
import shutil
import errno


class QemuServer(object):
    """
    Parent class to wrap a simple Qemu/KVM virtual machine used for testing.

    @param release: The Ubuntu release to use as the base image.
    @param arch: The hardware architecture of the OS image to download.
    @param data_dir: The directory to store the VM's data files.
    @param img_cache: The directory to store the pristine OS images so they
        only need to be downloaded once.
    """

    # The base url to download image files from.
    BASE_CLOUD_IMAGES_URL = "http://cloud-images.ubuntu.com/"

    def __init__(self, release="precise", arch="i386", data_dir=None,
                 img_cache="~/qemu_images", userdata=None):
        self.release = release
        self.arch = arch
        self._data_dir = data_dir
        self._img_cache = os.path.abspath(os.path.expanduser(img_cache))
        self._userdata = userdata
        self._root_disk = os.path.join(self._data_dir, "disk.img")
        self._ovf_transport = os.path.join(self._data_dir, "ovf.iso")
        # _ended indictes when the QEMU process has terminated
        self._ended = False
        # _ready indicates when the VM's cloud-init process completes
        self._ready = False

    def get_name(self):
        """
        Returns the human-readable name for the VM. This method can be
        overridden by subclasses to customize the instance name.

        @return: The instance's human-readable name.
        """
        return self.get_hostname()

    def get_hostname(self):
        """
        Returns the hostname for the instance. This method can be overridden
        by subclasses to customize the instance hostname.

        @return: The instance's hostname.
        """
        return "default"

    def get_instance_id(self):
        """
        Returns the instance_id for the instance. This method can be
        overridden by subclasses to customize the instance.

        @return: The instance's instance_id.
        """
        return str(uuid4())

    def get_userdata(self):
        """
        Returns the userdata for the instance. Use this to pass cloud-config
        scripts to customize the new instance. This method can be overridden
        by subclasses to customize the instance.

        @return: The userdata for the new instance.
        """
        return ("#cloud-config\n"
                "final_message: \"SYSTEM READY, after $UPTIME seconds\"")

    def get_extra_config(self):
        """
        Returns any additional arguments for the kvm command line that should
        be used when starting an instance. This method can be overridden by
        subclasses to customize the instance.

        @return: A list of additional command line arguments or None if no
            extra arguments are required.
        """
        return None

    def _get_current_sha1sums(self):
        """
        Queries the cloud-images website to get the SHA1 of the latest image
        file for this release and architecture.

        @return: The sha1 sum as a hex string of the latest image file.
        """
        sha1sum_url = urljoin(self.BASE_CLOUD_IMAGES_URL,
                              "/%s/current/SHA1SUMS" % self.release)
        sha1sums = urlopen(sha1sum_url).read()
        sums = {}
        for line in sha1sums.splitlines():
            sha1, filename = line.split()
            # Remove mysterious * from front of filenames
            if filename[0] == "*":
                filename = filename[1:]
            sums[filename] = sha1
        return sums

    @staticmethod
    def report_hook(block_num, block_size, total_size):
        """
        A default report_hook for indicating progress of an image file
        download.

        @param block_num: The block being downloaded.
        @param block_size: The block size used for downloading.
        @param total_size: The total size of the file being downloaded.
        """
        total_blocks = total_size / block_size
        report_blocks = [(total_blocks * x) / 10 for x in xrange(1, 11)]
        if block_num in report_blocks:
            percent = int(round((block_num * 100.0) / float(total_blocks)))
            print("Progress (of %sMB) %s%%" % (
                (total_size / (1024 * 1024)), percent))

    def get_qcow2_image(self):
        """
        Gets the local filename of the latest OS image file. If the current
        file is missing or out of date then a new copy is downloaded.

        @return: The local filename of the pristine image.
        """
        # Make sure cache directory exists
        mkdir_p(self._img_cache)

        # Find latest release available
        image_filename = "%s-server-cloudimg-%s-disk1.img" % (
            self.release, self.arch)
        sha1sums = self._get_current_sha1sums()
        if image_filename not in sha1sums:
            raise Exception("Image '%s' not available for %s on %s" % (
                            image_filename, self.release, self.arch))
        expected_sha1 = sha1sums[image_filename]

        # Check if we have it
        local_image_path = os.path.join(self._img_cache, image_filename)
        local_image_is_current = False
        if os.path.isfile(local_image_path):
            if expected_sha1 == _sha1_file(local_image_path):
                local_image_is_current = True

        # if not, download it
        image_url = urljoin(self.BASE_CLOUD_IMAGES_URL,
                            "/%s/current/%s" % (self.release, image_filename))
        if not local_image_is_current:
            print("Downloading %s" % image_url)
            urlretrieve(image_url, local_image_path, self.report_hook)
            if expected_sha1 != _sha1_file(local_image_path):
                raise Exception("Invalid file downloaded")

        # return the local path
        return local_image_path

    def get_instance_disk_image(self):
        """
        Gets the local filename of the disk image to use for this instance. If
        the disk image doesn't currently exist then a copy of the pristine
        image for this release and arch is used.

        @return: The local filename of the instance disk image.
        """
        # Check if we have the root disk
        if not os.path.exists(self._root_disk):
            if self.release is not None:
                # Get path to pristine image
                pristine_image = self.get_qcow2_image()
                # Copy into datadir
                print("Making copy of pristine image into %s" %
                      self._root_disk)
                shutil.copy(pristine_image, self._root_disk)
            else:
                # No release specified, make a blank image
                _make_empty_qcow2_image(self._root_disk)
        return self._root_disk

    def get_ovf_transport(self):
        """
        Gets the local filename of the OVF transport ISO used to pass instance
        data into the VM. If the file does not exist then one is created.

        @return The local filename of the OVF transport ISO.
        """
        if not os.path.exists(self._ovf_transport):
            print("Building new OVF transport: %s" % self._ovf_transport)
            # Build new iso
            instance_id = self.get_instance_id()
            hostname = self.get_hostname()
            if self._userdata is not None:
                userdata = self._userdata
            else:
                userdata = self.get_userdata()
            _gen_ovf_transport_iso(self._ovf_transport, instance_id, hostname,
                                   userdata)
        return self._ovf_transport

    def poweron(self):
        """
        Starts the VM instance in a subprocess and returns to the caller.
        """
        # Get the filename of the disk image
        image_path = self.get_instance_disk_image()

        # Get the filename of the OVF transport iso for cloud-init
        iso_path = self.get_ovf_transport()

        args = ["kvm",
                "-name", self.get_name(),
                "-m", str(512),
                "-drive", "file=%s,if=virtio" % image_path,
                "-cdrom", iso_path,
                "-serial", "stdio"]

        extra_args = self.get_extra_config()
        if extra_args is not None:
            args += extra_args

        # Create a queue for getting console output from the instance
        self._stdout_queue = Queue()
        # Start the subprocess
        self._kvm_process = Process(target=_run_process,
                                    args=(args, self._stdout_queue))
        self._kvm_process.start()
        # The first value passed through the queue is the PID of the
        # underlying kvm process.
        self._kvm_pid = self._stdout_queue.get()

    def wait_until_ready(self):
        """
        Blocks until the instance is ready to use. This uses the
        C{final_message:} command in the cloud config so indicate when
        cloud-init has finished initializing the instance. Console output is
        also written to the console.log file within the instance's data
        directory.
        """
        with open(os.path.join(self._data_dir, "console.log"), "ab") as f:
            while not (self._ready or self._ended):
                line = self._stdout_queue.get()
                if line is None:
                    self._ended = True
                    break
                f.write("%s\n" % line)
                f.flush()
                if line.startswith("SYSTEM READY"):
                    self._ready = True

    def wait(self):
        """
        Blocks until the instance has terminated (kvm process ends). Any
        additional console output is written to the console.log file in the
        instance's data directory.
        """
        with open(os.path.join(self._data_dir, "console.log"), "ab") as f:
            while not self._ended:
                line = self._stdout_queue.get()
                if line is None:
                    self._ended = True
                    break
                f.write("%s\n" % line)
                f.flush()
        self._kvm_process.join()

    def poweroff(self):
        """
        Terminates the vm then waits until the instance is cleaned up.
        """
        os.kill(self._kvm_pid, SIGTERM)
        self.wait()


def _run_process(args, stdout_queue):
    """
    Runs a command in a subprocess then consumes data from stdout and puts it
    on a queue for the parent process to use. The first queue message sent is
    the PID of the subprocess and the final queue message is C{None} to
    indicate the process has ended.

    @param args: The arguments used to start the subprocess.
    @param stdout_queue: A Queue object used to pass stdout lines to the
        parent.
    """
    p = Popen(args, stdout=PIPE)
    stdout_queue.put(p.pid)
    while True:
        line = p.stdout.readline()
        if line == "":
            break
        # Remove trailing \n
        line = line[:-1]
        stdout_queue.put(line)
    stdout_queue.put(None)
    p.wait()


def mkdir_p(path):
    """
    Make a directory recursively if it does not exist. If it does exist no
    error will be raised.

    @param path: The directory path to be created.
    """
    try:
        os.makedirs(path)
    except OSError as exc:
        if exc.errno == errno.EEXIST:
            pass
        else:
            raise


def _sha1_file(filename):
    """
    Take the sha1 sum of a file on disk.  Use the sha1sum command line program
    for speed.

    @param filename: The path to the file on disk to sha1sum.

    @return The sha1 sum of the file as a hex string.
    """
    output = check_output(["sha1sum", filename])
    sha1, _, _ = output.partition(" ")
    return sha1


def _make_empty_qcow2_image(image_filename):
    """
    Create an empty QCOW2 filesystem image for use by QEMU.

    @param image_filename: The filename of the new disk image.
    """
    with open("/dev/null", "wb") as fnull:
        check_call(["qemu-img", "create", "-f", "qcow2",
                    image_filename, "10G"], stderr=fnull)


def _genisoimage(title, outfile, in_dir):
    """
    Call the genisoimage to generate a .iso image file from a directory.

    @param title: The title of the disk.
    @param outfile: The name of the output .iso file.
    @param in_dir: The name of the directory whose contents should be on the
        disk.
    """
    with open("/dev/null", "wb") as fnull:
        check_call(["genisoimage", "-V", title, "-o", outfile, "-r", in_dir],
                   stderr=fnull)


def _gen_ovf_transport_iso(outfile, instance_id, hostname, userdata):
    """
    Generates an OVF transport ISO file used to get instance data into the new
    VM. The ISO file is connected to the new VM as a CD drive which cloud-init
    looks for.

    @param outfile: The name of the OVF file to create.
    @param instance_id: The instance_id of the new VM.
    @param hostname: The hostname of the new VM.
    @param userdata: Userdata to pass to the new VM.
    """
    temp_dir = mkdtemp()
    try:
        userdata_base64 = ""
        if userdata:
            userdata_base64 = b64encode(userdata)

        ovf_filename = os.path.join(temp_dir, "ovf-env.xml")
        with open(ovf_filename, "wb") as ovf_file:
            ovf = OVF_TEMPLATE % {"instance_id": instance_id,
                                  "hostname": hostname,
                                  "userdata_base64": userdata_base64,
                                  "seedfrom": "",
                                  "password": "ubuntu"}
            ovf_file.write(ovf)
        _genisoimage("OVF-TRANSPORT", outfile, temp_dir)
    finally:
        shutil.rmtree(temp_dir)

# The OVF Transport template file.
OVF_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<Environment xmlns="http://schemas.dmtf.org/ovf/environment/1"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:oe="http://schemas.dmtf.org/ovf/environment/1"
    xsi:schemaLocation=
        "http://schemas.dmtf.org/ovf/environment/1 ../dsp8027.xsd"
    oe:id="WebTier">

    <!-- This example reference a local schema file, to validate against
         online schema use:
    xsi:schemaLocation="http://schemas.dmtf.org/ovf/envelope/1
        http://schemas.dmtf.org/ovf/envelope/1/dsp8027_1.0.0.xsd"
    -->

    <!-- Information about hypervisor platform -->
    <oe:PlatformSection>
        <Kind>ESX Server</Kind>
        <Version>3.0.1</Version>
        <Vendor>VMware, Inc.</Vendor>
        <Locale>en_US</Locale>
    </oe:PlatformSection>

    <!--- Properties defined for this virtual machine -->
    <PropertySection>
        <Property oe:key="instance-id" oe:value="%(instance_id)s"/>
        <Property oe:key="hostname" oe:value="%(hostname)s"/>
        <Property oe:key="user-data" oe:value="%(userdata_base64)s"/>
        <Property oe:key="seedfrom" oe:value="%(seedfrom)s"/>
        <!-- <Property oe:key="password" oe:value="%(password)s"/> -->
    </PropertySection>

</Environment>"""
