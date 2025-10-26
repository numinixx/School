import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { BookOpen, Award, Clock, TrendingUp, User, Mail, Bot, Star, GraduationCap } from 'lucide-react';
import { fetchAttendance, fetchGrades, supabase } from '../lib/supabase';
import { Student } from '../lib/types';
import LoadingSpinner from './ui/LoadingSpinner';
import ModernCard from './ui/ModernCard';
import AIHelper from './AIHelper';
import RatingModal from './RatingModal';
import StudentMarksView from './StudentMarksView';
import toast from 'react-hot-toast';

interface StudentData extends Student {
  class_section: ReactNode;
  loggedAs?: string;
}

const StudentDashboard: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [student, setStudent] = useState<StudentData | null>(null);
  const [homework, setHomework] = useState<any[]>([]);
  const [attendance, setAttendance] = useState<any[]>([]);
  const [grades, setGrades] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [latestExamPercentage, setLatestExamPercentage] = useState<number>(0);
  const [assignmentsCount, setAssignmentsCount] = useState<number>(0);
  const [examsCount, setExamsCount] = useState<number>(0);
  const [showAIHelper, setShowAIHelper] = useState(false);
  const [showRatingModal, setShowRatingModal] = useState(false);

  useEffect(() => {
    // Get student data from route state or localStorage
    let studentData: StudentData | undefined = location.state?.user;
    
    if (!studentData) {
      try {
        const raw = localStorage.getItem('loggedUser');
        if (raw) {
          const loggedUser = JSON.parse(raw);
          if (loggedUser.loggedAs === 'student') {
            studentData = loggedUser;
          }
        }
      } catch (e) {
        console.error('Error parsing logged user:', e);
      }
    }

    if (!studentData) {
      navigate('/');
      return;
    }

    setStudent(studentData);
    loadStudentData(studentData);
  }, [location.state, navigate]);

  const loadStudentData = async (studentData: StudentData) => {
    try {
      setLoading(true);

      // Load homework for student's class and section from database
      const { data: homeworkData } = await supabase
        .from('homework')
        .select('*')
        .eq('class_name', studentData.class_name)
        .eq('section', studentData.section)
        .eq('status', 'active')
        .order('created_at', { ascending: false });
      setHomework(homeworkData || []);

      // Count assignments from last day (24 hours)
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const { data: recentHomework } = await supabase
        .from('homework')
        .select('id')
        .eq('class_name', studentData.class_name)
        .eq('section', studentData.section)
        .eq('status', 'active')
        .gte('created_at', yesterday.toISOString());
      setAssignmentsCount(recentHomework?.length || 0);

      // Load attendance (if student ID is available)
      if (studentData.id) {
        const { data: attendanceData } = await fetchAttendance(studentData.id);
        setAttendance(attendanceData || []);

        // Load grades
        const { data: gradesData } = await fetchGrades(studentData.id);
        setGrades(gradesData || []);

        // Get latest exam percentage using the database function
        const { data: percentageData, error: percentageError } = await supabase
          .rpc('get_latest_exam_percentage', { p_student_id: studentData.id });

        if (!percentageError && percentageData !== null) {
          // Supabase RPC may return the numeric directly, or an array/object wrapper depending on driver/version.
          let pct = 0;
          try {
            const coerceNumber = (v: any) => {
              if (typeof v === 'number') return v;
              if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
              return null;
            };

            if (typeof percentageData === 'number' || typeof percentageData === 'string') {
              const n = coerceNumber(percentageData);
              pct = n ?? 0;
            } else if (Array.isArray(percentageData)) {
              if (percentageData.length === 0) pct = 0;
              else {
                const first = percentageData[0];
                const n = coerceNumber(first);
                if (n !== null) pct = n;
                else if (first && typeof first === 'object') {
                  const vals = Object.values(first);
                  const found = vals.map(coerceNumber).find(v => v !== null);
                  pct = found ?? 0;
                }
              }
            } else if (percentageData && typeof percentageData === 'object') {
              const vals = Object.values(percentageData);
              const found = vals.map(coerceNumber).find(v => v !== null);
              pct = found ?? 0;
            }
          } catch (e) {
            pct = 0;
          }

          // If RPC returned 0 (possible due to DB state), try fallback sources
          let finalPct = Number(pct);

          if (!finalPct) {
            try {
              // 1) Try the materialized view / view that summarizes latest exam
              const { data: viewData, error: viewError } = await supabase
                .from('student_latest_exam_summary')
                .select('percentage')
                .eq('student_id', studentData.id)
                .maybeSingle();

              if (!viewError && viewData && typeof viewData.percentage === 'number' && viewData.percentage > 0) {
                finalPct = viewData.percentage;
              }
            } catch (e) {
              // ignore
            }
          }

          if (!finalPct && grades && grades.length > 0) {
            try {
              // grades array may contain per-subject or aggregated rows; use first entry if available
              const latest = grades[0];
              if (latest && typeof latest.marks_obtained === 'number' && typeof latest.total_marks === 'number' && latest.total_marks > 0) {
                finalPct = Math.round((latest.marks_obtained / latest.total_marks) * 100 * 100) / 100;
              }
            } catch (e) {
              // ignore
            }
          }

          // As a final fallback, try computing from marks table directly (group by latest exam_type)
          if (!finalPct) {
            try {
              const { data: latestExamRow } = await supabase
                .from('marks')
                .select('exam_type')
                .eq('student_id', studentData.id)
                .order('updated_at', { ascending: false })
                .limit(1)
                .maybeSingle();

              const latestExamType = latestExamRow?.exam_type;
              if (latestExamType) {
                const { data: marksRows } = await supabase
                  .from('marks')
                  .select('marks_obtained, total_marks')
                  .eq('student_id', studentData.id)
                  .eq('exam_type', latestExamType);

                if (Array.isArray(marksRows) && marksRows.length > 0) {
                  const total = marksRows.reduce((s, r: any) => s + Number(r.total_marks ?? 0), 0);
                  const obtained = marksRows.reduce((s, r: any) => s + Number(r.marks_obtained ?? 0), 0);
                  if (total > 0) finalPct = Math.round((Number(obtained) / Number(total)) * 100 * 100) / 100;
                }
              }
            } catch (e) {
              // ignore
            }
          }

          setLatestExamPercentage(Number(finalPct || 0));
        }

        // Count exams with filled results
        const { data: marksData } = await supabase
          .from('marks')
          .select('exam_type')
          .eq('student_id', studentData.id);

        const uniqueExams = [...new Set(marksData?.map(m => m.exam_type))];
        setExamsCount(uniqueExams.length);
      }
    } catch (error) {
      console.error('Error loading student data:', error);
      toast.error('Failed to load some data');
    } finally {
      setLoading(false);
    }
  };

  const calculateAttendancePercentage = () => {
    if (attendance.length === 0) return 96; // Default fallback
    const presentDays = attendance.filter(a => a.status === 'present').length;
    return Math.round((presentDays / attendance.length) * 100);
  };

  

  if (!student) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-red-600 mb-4">Access Denied</h2>
          <p className="text-gray-600 mb-4">Please login to access your student dashboard</p>
          <button
            onClick={() => navigate('/')}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg"
          >
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const attendancePercentage = calculateAttendancePercentage();
  

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-yellow-50 py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <ModernCard className="p-6">
            <div className="flex flex-col md:flex-row items-center gap-6">
              <div className="relative">
                <img
                  src={student.profile_photo || '/assest/logo.png'}
                  alt={`${student.name} profile`}
                  className="w-24 h-28 object-cover rounded-2xl border-4 border-white shadow-lg"
                />
                <div className="absolute -top-2 -right-2 w-6 h-6 bg-green-500 rounded-full border-2 border-white"></div>
              </div>

              <div className="flex-1 text-center md:text-left">
                <h1 className="text-3xl font-bold text-gray-900 mb-2">{student.name}</h1>
                <div className="flex flex-col md:flex-row gap-4 text-gray-600 mb-4">
                  <div className="flex items-center gap-2">
                    <User className="w-4 h-4" />
                    <span>Class: {student.class_section}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Mail className="w-4 h-4" />
                    <span>ID: {student.admission_id}</span>
                  </div>
                </div>
                
                <div className="flex flex-col md:flex-row gap-4">
                  <div className="bg-green-50 px-4 py-2 rounded-xl border border-green-200">
                    <div className="text-sm text-green-600 font-medium">Attendance</div>
                    <div className="text-2xl font-bold text-green-700">{attendancePercentage}%</div>
                  </div>
                  <div className="bg-blue-50 px-4 py-2 rounded-xl border border-blue-200">
                    <div className="text-sm text-blue-600 font-medium">Latest Score</div>
                    <div className="text-2xl font-bold text-blue-700">{latestExamPercentage}%</div>
                  </div>
                  <div className="bg-purple-50 px-4 py-2 rounded-xl border border-purple-200">
                    <div className="text-sm text-purple-600 font-medium">Status</div>
                    <div className="text-lg font-bold text-purple-700">Active</div>
                  </div>
                </div>
              </div>
            </div>
          </ModernCard>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column - Student Details */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.1 }}
            className="space-y-6"
          >
            <ModernCard className="p-6" gradient="blue">
              <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
                <User className="w-5 h-5" />
                Personal Details
              </h2>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-600">Name:</span>
                  <span className="font-medium">{student.name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Admission ID:</span>
                  <span className="font-medium">{student.admission_id}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Date of Birth:</span>
                  <span className="font-medium">{student.dob}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Blood Group:</span>
                  <span className="font-medium">{student.blood_group}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Class:</span>
                  <span className="font-medium">{student.class_section}</span>
                </div>
                {student.father_name && (
                  <div className="flex justify-between">
                    <span className="text-gray-600">Father's Name:</span>
                    <span className="font-medium">{student.father_name}</span>
                  </div>
                )}
                {student.email && (
                  <div className="flex justify-between">
                    <span className="text-gray-600">Email:</span>
                    <span className="font-medium">{student.email}</span>
                  </div>
                )}
                {student.phone && (
                  <div className="flex justify-between">
                    <span className="text-gray-600">Phone:</span>
                    <span className="font-medium">{student.phone}</span>
                  </div>
                )}
              </div>
            </ModernCard>

            {/* Quick Stats */}
            <ModernCard className="p-6" gradient="yellow">
              <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
                <TrendingUp className="w-5 h-5" />
                Quick Stats
              </h2>
              <div className="grid grid-cols-2 gap-4">
                <div className="text-center">
                  <div className="text-2xl font-bold text-green-600">{attendancePercentage}%</div>
                  <div className="text-sm text-gray-600">Attendance</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-blue-600">{latestExamPercentage}%</div>
                  <div className="text-sm text-gray-600">Latest Score</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-purple-600">{assignmentsCount}</div>
                  <div className="text-sm text-gray-600">Assignments</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-orange-600">{examsCount}</div>
                  <div className="text-sm text-gray-600">Exams</div>
                </div>
              </div>
            </ModernCard>
          </motion.div>

          {/* Right Column - Homework and Activities */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2 }}
            className="lg:col-span-2 space-y-6"
          >
            {/* Homework Section */}
            <ModernCard className="p-6" gradient="purple">
              <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
                <BookOpen className="w-5 h-5" />
                Recent Homework
              </h2>
              {homework.length === 0 ? (
                <div className="text-center py-8">
                  <BookOpen className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-500">No homework assigned yet.</p>
                </div>
              ) : (
                <div className="space-y-4 max-h-96 overflow-y-auto">
                  {homework.slice(0, 5).map((hw, index) => (
                    <motion.div
                      key={hw.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.1 }}
                      className="bg-white/50 rounded-xl p-4 border border-white/20"
                    >
                      <div className="flex items-start justify-between mb-2">
                        <h3 className="font-semibold text-gray-900">{hw.title}</h3>
                        {hw.submission_date && (
                          <div className="flex items-center gap-1 text-sm text-gray-500">
                            <Clock className="w-4 h-4" />
                            <span>{new Date(hw.submission_date).toLocaleDateString()}</span>
                          </div>
                        )}
                      </div>
                      <p className="text-gray-700 text-sm mb-2">{hw.description}</p>
                      <div className="flex items-center justify-between text-xs text-gray-500">
                        <span>Subject: {hw.subject}</span>
                        <span>By: {hw.teacher_name || 'Teacher'}</span>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </ModernCard>

            {/* Academic Performance Section */}
            <ModernCard className="p-6" gradient="blue">
              <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
                <GraduationCap className="w-5 h-5" />
                Academic Performance
              </h2>
              <StudentMarksView
                studentId={student.id}
                admissionId={student.admission_id}
                classId={student.class_id || ''}
              />
            </ModernCard>

            {/* Recent Grades */}
            <ModernCard className="p-6" gradient="green">
              <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
                <Award className="w-5 h-5" />
                Recent Comments
              </h2>
              {grades.length === 0 ? (
                <div className="text-center py-8">
                  <Award className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-500">No comments available yet.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {grades.slice(0, 5).map((grade, index) => (
                    <motion.div
                      key={grade.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: index * 0.1 }}
                      className="bg-white/50 rounded-xl p-4 border border-white/20"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="font-semibold text-gray-900">{grade.subject}</h3>
                          <p className="text-sm text-gray-600">{grade.exam_type}</p>
                        </div>
                        <div className="text-right">
                          <div className="text-2xl font-bold text-blue-600">
                            {Math.round((grade.marks_obtained / grade.total_marks) * 100)}%
                          </div>
                          <div className="text-sm text-gray-500">
                            {grade.marks_obtained}/{grade.total_marks}
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}
            </ModernCard>
          </motion.div>
        </div>

        {/* Floating Action Buttons */}
        <div className="fixed bottom-8 right-8 flex flex-col gap-4 z-40">
          {/* AI Helper Button */}
          <motion.button
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.5, type: 'spring' }}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => setShowAIHelper(true)}
            className="w-16 h-16 bg-gradient-to-r from-blue-600 to-cyan-600 text-white rounded-full shadow-xl hover:shadow-2xl flex items-center justify-center group relative"
            title="AI Study Assistant"
          >
            <Bot className="w-8 h-8" />
            <span className="absolute right-full mr-4 bg-gray-900 text-white text-sm px-3 py-2 rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
              AI Study Assistant
            </span>
          </motion.button>

          {/* Rating Button */}
          <motion.button
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.6, type: 'spring' }}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => setShowRatingModal(true)}
            className="w-16 h-16 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-full shadow-xl hover:shadow-2xl flex items-center justify-center group relative"
            title="Submit Rating"
          >
            <Star className="w-8 h-8" />
            <span className="absolute right-full mr-4 bg-gray-900 text-white text-sm px-3 py-2 rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
              Submit Rating
            </span>
          </motion.button>
        </div>
      </div>

      {/* AI Helper Modal */}
      <AnimatePresence>
        {showAIHelper && (
          <AIHelper
            studentName={student?.name || 'Student'}
            onClose={() => setShowAIHelper(false)}
          />
        )}
      </AnimatePresence>

      {/* Rating Modal */}
      <AnimatePresence>
        {showRatingModal && student?.id && (
          <RatingModal
            studentId={student.id}
            onClose={() => setShowRatingModal(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

export default StudentDashboard;